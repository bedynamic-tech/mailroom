import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { requireWebAccess } from "../src/worker/api/access.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";

const issuer = "https://test.cloudflareaccess.com";
const audience = "web-application-aud";
const env = { WEB_ACCESS_TEAM_DOMAIN: issuer, WEB_ACCESS_AUD: audience };
const origin = "https://mailroom.example.com";
const key = await generateKeyPair("RS256");
const publicJwk = { ...await exportJWK(key.publicKey), kid: "test-key", alg: "RS256", use: "sig" };

async function assertion(overrides = {}, signingKey = key.privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iss: issuer, aud: [audience], sub: "owner-id", email: "owner@example.com", type: "app", iat: now, exp: now + 600, ...overrides };
  for (const name of Object.keys(payload)) if (payload[name] === undefined) delete payload[name];
  return new SignJWT(payload).setProtectedHeader({ alg: "RS256", kid: "test-key" }).sign(signingKey);
}

function fixture(t) {
  t.mock.method(globalThis, "fetch", async (url) => {
    assert.equal(String(url), `${issuer}/cdn-cgi/access/certs`);
    return Response.json({ keys: [publicJwk] });
  });
  let calls = 0;
  const api = new Hono();
  api.use("*", requireSameOrigin);
  api.all("/*", (c) => { calls++; return c.json({ ok: true }); });
  const app = new Hono();
  app.use("/api/*", requireWebAccess);
  app.route("/api", api);
  return {
    calls: () => calls,
    request: (path, headers = {}, init = {}, bindings = env) => app.request(`${origin}${path}`, { ...init, headers }, bindings),
  };
}

test("all API paths require a signed assertion, not cookies or identity headers", async (t) => {
  const { request, calls } = fixture(t);
  for (const path of ["/api/mailboxes", "/api/threads/1", "/api/attachments/1", "/api/settings/general", "/api/unknown"]) {
    for (const headers of [{}, { "Cf-Access-Authenticated-User-Email": "owner@example.com" }, { Cookie: "CF_Authorization=forged" }, { Authorization: "Bearer forged" }, { "Cf-Access-Jwt-Assertion": "forged" }]) {
      const response = await request(path, headers);
      assert.equal(response.status, 401, path);
      assert.equal(response.headers.get("Cache-Control"), "private, no-store");
    }
  }
  assert.equal(calls(), 0);
});

test("accepts a signed user assertion only for this issuer and application", async (t) => {
  const { request, calls } = fixture(t);
  const response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion() });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "private, no-store");
  assert.equal(calls(), 1);
});

test("rejects wrong signatures, MCP audiences, expired/future tokens, and missing required claims", async (t) => {
  const { request, calls } = fixture(t);
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { iss: "https://other.cloudflareaccess.com" }, { aud: ["mcp-application-aud"] },
    { exp: now - 1 }, { nbf: now + 600 }, { exp: undefined }, { sub: undefined },
    { email: undefined }, { type: undefined },
  ]) {
    const response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion(claims) });
    assert.equal(response.status, 401, JSON.stringify(claims));
  }
  const otherKey = await generateKeyPair("RS256");
  assert.equal((await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion({}, otherKey.privateKey) })).status, 401);
  const hmacToken = await new SignJWT({ iss: issuer, aud: audience }).setProtectedHeader({ alg: "HS256" }).sign(new Uint8Array(32));
  assert.equal((await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": hmacToken })).status, 401);
  assert.equal(calls(), 0);
});

test("rejects service tokens and incomplete user identities", async (t) => {
  const { request, calls } = fixture(t);
  for (const claims of [{ type: "service" }, { sub: "" }, { email: " " }, { email: 42 }]) {
    assert.equal((await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion(claims) })).status, 403);
  }
  assert.equal(calls(), 0);
});

test("fails closed on missing or unsafe configuration, including localhost and spoofed bypass headers", async (t) => {
  const { request, calls } = fixture(t);
  for (const bindings of [
    {}, { WEB_ACCESS_TEAM_DOMAIN: issuer }, { WEB_ACCESS_AUD: audience },
    ...["http://test.cloudflareaccess.com", "https://test.cloudflareaccess.com.attacker.example", "https://user@test.cloudflareaccess.com", `${issuer}/path`, "http://localhost:5173"].map(value => ({ ...env, WEB_ACCESS_TEAM_DOMAIN: value })),
  ]) {
    const response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion(), "X-Forwarded-Host": "localhost", "X-Dev-Auth-Bypass": "true" }, {}, bindings);
    assert.equal(response.status, 503);
  }
  assert.equal(calls(), 0);
});

test("failures carry setup codes, and hints only echo the request's own well-formed assertion", async (t) => {
  const { request } = fixture(t);
  const realAud = "a".repeat(64);
  const signed = await assertion({ aud: [realAud] });

  let response = await request("/api/mailboxes", {}, {}, {});
  assert.deepEqual(await response.json(), { error: "Web authentication is not configured", code: "access_not_configured" });

  response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": signed }, {}, {});
  assert.equal(response.status, 503);
  assert.deepEqual((await response.json()).hint, { team_domain: issuer, aud: realAud });

  response = await request("/api/mailboxes");
  assert.equal(response.status, 401);
  assert.equal((await response.json()).code, "access_missing");

  response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": signed });
  assert.equal(response.status, 401);
  const invalid = await response.json();
  assert.equal(invalid.code, "access_invalid");
  assert.deepEqual(invalid.hint, { team_domain: issuer, aud: realAud });

  for (const claims of [{ iss: "https://evil.example" }, { aud: ["not-an-aud"] }]) {
    response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion(claims) }, {}, {});
    assert.equal((await response.json()).hint, undefined, JSON.stringify(claims));
  }
  response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": "not-a-jwt" }, {}, {});
  assert.equal((await response.json()).hint, undefined);
});

test("JWKS outages deny access without running a handler", async (t) => {
  const { request, calls } = fixture(t);
  t.mock.method(globalThis, "fetch", async () => { throw new TypeError("network unavailable"); });
  const response = await request("/api/mailboxes", { "Cf-Access-Jwt-Assertion": await assertion() }, {}, { ...env, WEB_ACCESS_TEAM_DOMAIN: "https://unavailable.cloudflareaccess.com" });
  assert.equal(response.status, 503);
  assert.equal(calls(), 0);
});

test("a valid login does not bypass CSRF checks on writes", async (t) => {
  const { request, calls } = fixture(t);
  const headers = { "Cf-Access-Jwt-Assertion": await assertion() };
  for (const source of [undefined, "https://attacker.example", "null"]) {
    const response = await request("/api/threads/1/reply", { ...headers, ...(source ? { Origin: source } : {}) }, { method: "POST", body: new FormData() });
    assert.equal(response.status, 403);
  }
  assert.equal(calls(), 0);
  assert.equal((await request("/api/threads/1/reply", { ...headers, Origin: origin }, { method: "POST", body: new FormData() })).status, 200);
  assert.equal(calls(), 1);
});
