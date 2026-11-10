import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { threadContactApi } from "../src/worker/api/thread-contact.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { forwardedSender } from "../src/shared/forwarded-sender.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, last_message_at, reply_recipients)
      VALUES (1, 1, 'Fwd: Refund', '2026-01-01T00:00:00.000Z', '{"to":["kyle@home.example"],"cc":null,"bcc":["boss@example.org"]}'),
             (2, 1, 'Hello', '2026-01-01T00:00:00.000Z', NULL);
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, from_name, reply_to_addresses, text_body, created_at)
      VALUES (1, 1, '<a@x>', 'inbound', 'kyle@home.example', 'Kyle', '["kyle+reply@home.example"]', 'fyi', '2026-01-01T00:00:00.000Z'),
             (2, 1, '<b@x>', 'outbound', 'support@example.com', NULL, '[]', 'On it', '2026-01-01T00:01:00.000Z'),
             (3, 1, '<c@x>', 'inbound', 'KYLE@home.example', 'Kyle', '[]', 'more', '2026-01-01T00:02:00.000Z'),
             (4, 2, '<d@x>', 'outbound', 'support@example.com', NULL, '[]', 'hi', '2026-01-01T00:00:00.000Z');`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
    };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try { const results = []; for (const item of statements) results.push(await item.run()); db.exec("COMMIT"); return results; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
  };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/threads", threadContactApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/threads${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  const messages = () => db.prepare(
    `SELECT id, from_address, from_name, reply_to_addresses, original_from_address, original_from_name,
       original_reply_to_addresses FROM messages ORDER BY id`,
  ).all().map((row) => ({ ...row }));
  return { db, call, messages };
}

test("changing the contact reassigns every received email from the current sender", async (t) => {
  const f = fixture(t);
  const { status, body } = await f.call("PUT", "/1/contact", { address: "Jane@Customer.example", name: " Jane Doe " });
  assert.equal(status, 200);
  assert.equal(body.updated, 2);
  const [first, sent, second] = f.messages();
  assert.deepEqual(first, {
    id: 1,
    from_address: "jane@customer.example",
    from_name: "Jane Doe",
    reply_to_addresses: "[]",
    original_from_address: "kyle@home.example",
    original_from_name: "Kyle",
    original_reply_to_addresses: '["kyle+reply@home.example"]',
  });
  assert.equal(second.from_address, "jane@customer.example");
  assert.equal(second.original_from_address, "KYLE@home.example");
  assert.equal(sent.from_address, "support@example.com");
  assert.equal(sent.original_from_address, null);
  // An edited reply To follows the new contact; Bcc edits stay.
  const saved = JSON.parse(f.db.prepare("SELECT reply_recipients FROM threads WHERE id = 1").get().reply_recipients);
  assert.deepEqual(saved, { to: null, cc: null, bcc: ["boss@example.org"] });
});

test("changing the contact twice keeps the sender the email arrived with, and restore puts it back", async (t) => {
  const f = fixture(t);
  await f.call("PUT", "/1/contact", { address: "jane@customer.example", name: "Jane" });
  await f.call("PUT", "/1/contact", { address: "joe@customer.example" });
  const [first] = f.messages();
  assert.equal(first.from_address, "joe@customer.example");
  assert.equal(first.from_name, null);
  assert.equal(first.original_from_address, "kyle@home.example");
  assert.equal(first.original_from_name, "Kyle");

  const { status, body } = await f.call("DELETE", "/1/contact");
  assert.equal(status, 200);
  assert.equal(body.updated, 2);
  const [restored, , other] = f.messages();
  assert.deepEqual(restored, {
    id: 1,
    from_address: "kyle@home.example",
    from_name: "Kyle",
    reply_to_addresses: '["kyle+reply@home.example"]',
    original_from_address: null,
    original_from_name: null,
    original_reply_to_addresses: null,
  });
  assert.equal(other.from_address, "KYLE@home.example");
});

test("changing the contact rejects bad input, own inboxes and conversations with nothing received", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call("PUT", "/1/contact", { address: "not an email" })).status, 400);
  const own = await f.call("PUT", "/1/contact", { address: "Support@example.com" });
  assert.equal(own.status, 400);
  assert.match(own.body.error, /inboxes/);
  assert.equal((await f.call("PUT", "/2/contact", { address: "jane@customer.example" })).status, 409);
  assert.equal((await f.call("PUT", "/99/contact", { address: "jane@customer.example" })).status, 404);
  assert.equal(f.messages()[0].from_address, "kyle@home.example");
});

test("forwardedSender reads the original sender from common forward headers", () => {
  assert.deepEqual(
    forwardedSender("FYI\n\n---------- Forwarded message ---------\nFrom: Jane Doe <Jane@Customer.example>\nDate: Mon\nSubject: Refund\n\nHi"),
    { address: "jane@customer.example", name: "Jane Doe" },
  );
  assert.deepEqual(
    forwardedSender("Begin forwarded message:\n\n> From: \"Doe, Jane\" <jane@customer.example>\n> Subject: Refund"),
    { address: "jane@customer.example", name: "Doe, Jane" },
  );
  assert.deepEqual(
    forwardedSender("________________________________\nFrom: Jane Doe [mailto:jane@customer.example]\nSent: Monday"),
    { address: "jane@customer.example", name: "Jane Doe" },
  );
  assert.deepEqual(
    forwardedSender("---------- Forwarded message ---------\nFrom: *Jane Doe* <jane@customer.example>"),
    { address: "jane@customer.example", name: "Jane Doe" },
  );
  assert.deepEqual(
    forwardedSender("-----Original Message-----\nFrom: jane@customer.example\nSent: Monday"),
    { address: "jane@customer.example", name: null },
  );
  assert.equal(forwardedSender("From: jane@customer.example\nNo forward marker here"), null);
  assert.equal(forwardedSender(null), null);
});
