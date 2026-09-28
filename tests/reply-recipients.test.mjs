import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { replyRecipientsApi } from "../src/worker/api/reply-recipients.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import {
  EMPTY_REPLY_RECIPIENTS,
  parseReplyRecipients,
  serializeReplyRecipients,
} from "../src/shared/reply-recipients.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, last_message_at, status)
      VALUES (1, 1, 'Refund request', '2026-01-01T00:00:00.000Z', 'open');`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
    };
  }
  const env = { DB: { prepare: statement } };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/threads", replyRecipientsApi);
  const put = async (path, body) => {
    const response = await app.request(`https://mailroom.example/api/threads${path}`, {
      method: "PUT",
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  const stored = () => db.prepare("SELECT reply_recipients FROM threads WHERE id = 1").get().reply_recipients;
  return { put, stored };
}

test("edited reply recipients are saved on the conversation", async (t) => {
  const f = fixture(t);
  const recipients = { to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"] };
  assert.equal((await f.put("/1/reply-recipients", recipients)).status, 200);
  assert.deepEqual(parseReplyRecipients(f.stored()), recipients);
});

test("an unedited To is kept as unedited, and no edits clear the saved value", async (t) => {
  const f = fixture(t);
  await f.put("/1/reply-recipients", { to: null, cc: ["b@example.com"], bcc: [] });
  assert.equal(parseReplyRecipients(f.stored()).to, null);
  await f.put("/1/reply-recipients", EMPTY_REPLY_RECIPIENTS);
  assert.equal(f.stored(), null);
});

test("invalid recipients and unknown conversations are refused", async (t) => {
  const f = fixture(t);
  assert.equal((await f.put("/1/reply-recipients", { to: ["not an address"], cc: [], bcc: [] })).status, 400);
  assert.equal((await f.put("/1/reply-recipients", { to: null, cc: "x", bcc: [] })).status, 400);
  const tooMany = Array.from({ length: 60 }, (_, i) => `p${i}@example.com`);
  assert.equal((await f.put("/1/reply-recipients", { to: tooMany.slice(0, 30), cc: tooMany.slice(30), bcc: [] })).status, 400);
  assert.equal(f.stored(), null);
  assert.equal((await f.put("/99/reply-recipients", EMPTY_REPLY_RECIPIENTS)).status, 404);
});

test("unreadable stored recipients fall back to no edits", () => {
  assert.deepEqual(parseReplyRecipients(null), EMPTY_REPLY_RECIPIENTS);
  assert.deepEqual(parseReplyRecipients("{not json"), EMPTY_REPLY_RECIPIENTS);
  assert.deepEqual(parseReplyRecipients(JSON.stringify({ to: "x", cc: [1] })), EMPTY_REPLY_RECIPIENTS);
  assert.equal(serializeReplyRecipients(EMPTY_REPLY_RECIPIENTS), null);
});
