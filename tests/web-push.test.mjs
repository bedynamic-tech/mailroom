import assert from "node:assert/strict";
import test from "node:test";
import {
  base64urlDecode,
  base64urlEncode,
  buildWebPushRequest,
  encryptAes128gcm,
} from "../src/worker/notifications/web-push.ts";

// RFC 8291 section 5.
const vector = {
  plaintext: "When I grow up, I want to be a watermelon",
  asPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  asPublic:
    "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
  uaPublic:
    "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  uaPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body:
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};

async function importEcdhPair(privateD, publicB64) {
  const point = base64urlDecode(publicB64);
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: base64urlEncode(point.slice(1, 33)),
    y: base64urlEncode(point.slice(33, 65)),
  };
  const params = { name: "ECDH", namedCurve: "P-256" };
  return {
    privateKey: await crypto.subtle.importKey("jwk", { ...jwk, d: privateD }, params, true, ["deriveBits"]),
    publicKey: await crypto.subtle.importKey("jwk", jwk, params, true, []),
  };
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// What a browser does on receipt (RFC 8188 + 8291), written independently.
async function decryptAsBrowser(body, uaKeys, authSecret) {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20];
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: asKey }, uaKeys.privateKey, 256));
  const uaPublic = new Uint8Array(await crypto.subtle.exportKey("raw", uaKeys.publicKey));
  const enc = new TextEncoder();
  const info = new Uint8Array([...enc.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(authSecret, secret, info, 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const record = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end -= 1;
  assert.equal(record[end], 0x02, "last record delimiter");
  return { recordSize, text: new TextDecoder().decode(record.slice(0, end)) };
}

test("encrypts the RFC 8291 test vector byte for byte", async () => {
  const body = await encryptAes128gcm(
    new TextEncoder().encode(vector.plaintext),
    { p256dh: vector.uaPublic, auth: vector.auth },
    { salt: base64urlDecode(vector.salt), localKeys: await importEcdhPair(vector.asPrivate, vector.asPublic) },
  );
  assert.equal(base64urlEncode(body), vector.body);
});

test("builds an aes128gcm VAPID request a browser can decrypt", async () => {
  const vapid = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const privateJWK = await crypto.subtle.exportKey("jwk", vapid.privateKey);
  const browser = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));
  const payload = JSON.stringify({ title: "New email from Alice", body: "Refund", data: { url: "/inbox/1" } });

  const request = await buildWebPushRequest({
    subscription: {
      endpoint: "https://web.push.apple.com/QGuQyavXutnMH",
      keys: {
        p256dh: base64urlEncode(new Uint8Array(await crypto.subtle.exportKey("raw", browser.publicKey))),
        auth: base64urlEncode(authSecret),
      },
    },
    privateJWK: JSON.stringify(privateJWK),
    subject: "mailto:admin@example.com",
    payload,
    ttl: 3600,
    topic: "conversation-1",
  });

  assert.equal(request.headers["Content-Encoding"], "aes128gcm");
  assert.equal(request.headers.TTL, "3600");
  assert.equal(request.headers.Topic, "conversation-1");
  assert.equal(request.headers.Urgency, undefined);
  assert.equal(request.headers.Encryption, undefined);
  assert.equal(request.headers["Crypto-Key"], undefined);

  const decrypted = await decryptAsBrowser(request.body, browser, authSecret);
  assert.equal(decrypted.text, payload);
  assert.equal(decrypted.recordSize, 4096);

  const match = /^vapid t=([^,]+), k=(\S+)$/.exec(request.headers.Authorization);
  assert.ok(match);
  const [header, claims, signature] = match[1].split(".");
  const decodedClaims = JSON.parse(new TextDecoder().decode(base64urlDecode(claims)));
  assert.equal(decodedClaims.aud, "https://web.push.apple.com");
  assert.equal(decodedClaims.sub, "mailto:admin@example.com");
  const now = Math.floor(Date.now() / 1000);
  assert.ok(decodedClaims.exp > now && decodedClaims.exp <= now + 24 * 60 * 60);
  const publicKey = await crypto.subtle.importKey("raw", base64urlDecode(match[2]), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
  const valid = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    publicKey,
    base64urlDecode(signature),
    new TextEncoder().encode(`${header}.${claims}`),
  );
  assert.equal(valid, true);
});
