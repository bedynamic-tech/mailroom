import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";

const origin = "https://mailroom.example.com";

function fixture() {
  const api = new Hono();
  let writes = 0;
  api.use("*", requireSameOrigin);
  api.all("/*", (c) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) writes++;
    return c.json({ ok: true });
  });
  const app = new Hono().route("/api", api);
  return { app, writes: () => writes };
}

test("rejects unsafe requests before handlers run, for every write method and body type", async () => {
  const { app, writes } = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const contentType of ["application/json", "application/x-www-form-urlencoded", "multipart/form-data; boundary=test", "text/plain"]) {
      for (const source of [undefined, "null", "https://attacker.example", "https://other.example.com", `${origin}.attacker.example`, `${origin}/`, "http://mailroom.example.com"]) {
        const response = await app.request(`${origin}/api/threads/1/reply`, {
          method,
          headers: { "Content-Type": contentType, ...(source === undefined ? {} : { Origin: source }) },
          body: "test",
        });
        assert.equal(response.status, 403, `${method} ${contentType} ${source}`);
      }
    }
  }
  assert.equal(writes(), 0);
});

test("rejects contradictory Fetch Metadata even with a matching Origin", async () => {
  const { app, writes } = fixture();
  for (const site of ["cross-site", "same-site", "none"]) {
    const response = await app.request(`${origin}/api/threads/1/archive`, {
      method: "POST", headers: { Origin: origin, "Sec-Fetch-Site": site },
    });
    assert.equal(response.status, 403);
  }
  assert.equal(writes(), 0);
});

test("allows same-origin writes, including browsers without Fetch Metadata", async () => {
  const { app, writes } = fixture();
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    for (const metadata of [{}, { "Sec-Fetch-Site": "same-origin" }]) {
      const response = await app.request(`${origin}/api/threads/1/reply`, {
        method, headers: { Origin: origin, ...metadata }, body: new FormData(),
      });
      assert.equal(response.status, 200);
    }
  }
  assert.equal(writes(), 8);
});

test("read requests do not require Origin; localhost writes still require an exact origin", async () => {
  const { app, writes } = fixture();
  for (const method of ["GET", "HEAD", "OPTIONS"]) {
    assert.equal((await app.request(`${origin}/api/mailboxes`, { method })).status, 200);
  }
  for (const [source, status] of [["http://localhost:5173", 200], ["http://localhost:5174", 403]]) {
    const response = await app.request("http://localhost:5173/api/threads/1/read", {
      method: "POST", headers: { Origin: source },
    });
    assert.equal(response.status, status);
  }
  assert.equal(writes(), 1);
});
