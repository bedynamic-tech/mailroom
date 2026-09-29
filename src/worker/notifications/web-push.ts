// Web Push request builder: RFC 8291 message encryption (aes128gcm) and
// RFC 8292 VAPID authentication, using only Web Crypto.
//
// aes128gcm is the one content coding every push service accepts. Apple's
// service (Safari and iOS Home Screen apps) rejects the older draft "aesgcm"
// coding outright, so it must not be used.

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface WebPushRequestOptions {
  subscription: WebPushSubscription;
  /** Private VAPID key as a JWK (object or JSON string). */
  privateJWK: JsonWebKey | string;
  /** VAPID contact: a mailto: address or an HTTPS URL. */
  subject: string;
  payload: string;
  /** Seconds the push service may hold an undelivered message. */
  ttl: number;
  /** Replaces an undelivered message with the same topic. */
  topic?: string;
  urgency?: "very-low" | "low" | "normal" | "high";
}

export interface WebPushRequest {
  endpoint: string;
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}

/** Test hooks for fixed key material (RFC 8291 section 5). */
export interface WebPushEncryptionOverrides {
  salt?: Uint8Array<ArrayBuffer>;
  localKeys?: CryptoKeyPair;
}

const RECORD_SIZE = 4096;
// A single record must hold the 86-byte header, the payload, one delimiter
// byte and the 16-byte tag.
const MAX_PAYLOAD_BYTES = RECORD_SIZE - 86 - 1 - 16;
// Push services only promise to accept 4096 bytes of body.
const MAX_BODY_BYTES = 4096;

export async function buildWebPushRequest(
  options: WebPushRequestOptions,
  overrides: WebPushEncryptionOverrides = {},
): Promise<WebPushRequest> {
  const jwk: JsonWebKey =
    typeof options.privateJWK === "string" ? JSON.parse(options.privateJWK) : options.privateJWK;
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.x || !jwk.y || !jwk.d) {
    throw new Error("VAPID private key must be a P-256 JWK");
  }
  const endpoint = new URL(options.subscription.endpoint);
  if (endpoint.protocol !== "https:") throw new Error("Push endpoints must use HTTPS");

  const body = await encryptAes128gcm(
    new TextEncoder().encode(options.payload),
    options.subscription.keys,
    overrides,
  );
  const vapidPublicKey = base64urlEncode(
    concat(new Uint8Array([0x04]), base64urlDecode(jwk.x), base64urlDecode(jwk.y)),
  );
  const token = await vapidToken(jwk, {
    aud: endpoint.origin,
    // A fresh token signs every send, so a short life costs nothing.
    exp: Math.floor(Date.now() / 1000) + 60 * 60,
    sub: options.subject,
  });

  const headers: Record<string, string> = {
    Authorization: `vapid t=${token}, k=${vapidPublicKey}`,
    "Content-Encoding": "aes128gcm",
    "Content-Type": "application/octet-stream",
    TTL: String(Math.max(0, Math.floor(options.ttl))),
  };
  if (options.topic) headers.Topic = options.topic;
  if (options.urgency) headers.Urgency = options.urgency;
  return { endpoint: endpoint.href, headers, body };
}

export async function encryptAes128gcm(
  plaintext: Uint8Array,
  keys: { p256dh: string; auth: string },
  overrides: WebPushEncryptionOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.byteLength > MAX_PAYLOAD_BYTES) {
    throw new Error(`Push payload is ${plaintext.byteLength} bytes; the limit is ${MAX_PAYLOAD_BYTES}`);
  }
  const uaPublicBytes = base64urlDecode(keys.p256dh);
  const authSecret = base64urlDecode(keys.auth);
  if (uaPublicBytes.byteLength !== 65 || uaPublicBytes[0] !== 0x04) {
    throw new Error("Subscription p256dh key must be an uncompressed P-256 point");
  }
  if (authSecret.byteLength !== 16) throw new Error("Subscription auth secret must be 16 bytes");

  const uaPublic = await crypto.subtle.importKey(
    "raw",
    uaPublicBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const localKeys =
    overrides.localKeys ??
    ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as CryptoKeyPair);
  const asPublicBytes = new Uint8Array(
    (await crypto.subtle.exportKey("raw", localKeys.publicKey)) as ArrayBuffer,
  );
  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(16));

  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      // Standard Web Crypto spelling; the Workers types name this field $public.
      { name: "ECDH", public: uaPublic } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      localKeys.privateKey,
      256,
    ),
  );
  const keyInfo = concat(utf8("WebPush: info\0"), uaPublicBytes, asPublicBytes);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const cek = await hkdf(salt, ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, utf8("Content-Encoding: nonce\0"), 12);

  // One record, so it is also the last: the delimiter is 0x02, no padding.
  const record = concat(plaintext, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, record),
  );

  const header = new Uint8Array(16 + 4 + 1 + asPublicBytes.byteLength);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublicBytes.byteLength;
  header.set(asPublicBytes, 21);
  const body = concat(header, ciphertext);
  if (body.byteLength > MAX_BODY_BYTES) throw new Error("Push payload is too large");
  return body;
}

async function vapidToken(
  jwk: JsonWebKey,
  claims: { aud: string; exp: number; sub: string },
): Promise<string> {
  const unsigned = `${base64urlEncode(utf8(JSON.stringify({ typ: "JWT", alg: "ES256" })))}.${base64urlEncode(
    utf8(JSON.stringify(claims)),
  )}`;
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y, d: jwk.d },
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  // Web Crypto returns the raw r||s signature JWS expects.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(unsigned));
  return `${unsigned}.${base64urlEncode(new Uint8Array(signature))}`;
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: Uint8Array<ArrayBuffer>,
  length: number,
): Promise<Uint8Array<ArrayBuffer>> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8),
  );
}

function utf8(value: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(value) as Uint8Array<ArrayBuffer>;
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(normalized + "=".repeat((4 - (normalized.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
