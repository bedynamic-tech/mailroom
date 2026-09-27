import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { composeApi } from "../src/worker/api/compose.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { sendNewEmailAttempt } from "../src/worker/email/compose.ts";

function fixture(t, { fail = false } = {}) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active'), (2, 'pending.example', 'pending');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1), (2, 'support@pending.example', 2);`);
  const sent = [];
  const objects = new Map();
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
    RAW: { async put(key, value) { objects.set(key, value); } },
    EMAIL: { async send(message) { sent.push(message); if (fail) throw new Error("Provider unavailable"); return { messageId: `message-${sent.length}@example.com` }; } },
  };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/compose", composeApi);
  const post = (form, origin = "https://mailroom.example") => app.request("https://mailroom.example/api/compose", { method: "POST", headers: { Origin: origin }, body: form }, env);
  return { db, sent, objects, env, post };
}

function message(overrides = {}, files = []) {
  const form = new FormData();
  for (const [key, value] of Object.entries({ mailbox_id: "1", to: "person@example.com", subject: "A new conversation", text: "Hello from a human", attempt_id: crypto.randomUUID(), ...overrides })) form.set(key, value);
  for (const file of files) form.append("attachments", file);
  return form;
}

test("Web compose sends as a human, persists a new conversation and attachments, and deduplicates retries", async (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  const files = [new File(["attachment content"], "notes.txt", { type: "text/plain" })];
  const first = await f.post(message({ attempt_id: id }, files));
  assert.equal(first.status, 200);
  const result = await first.json();
  assert.equal(result.status, "sent");
  const replay = await f.post(message({ attempt_id: id }, files));
  assert.deepEqual(await replay.json(), result);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].from, "support@example.com");
  assert.equal(f.sent[0].headers["Auto-Submitted"], undefined);
  assert.equal(f.sent[0].attachments[0].filename, "notes.txt");
  const stored = f.db.prepare("SELECT * FROM messages").get();
  assert.equal(stored.sent_by, "human");
  assert.equal(stored.thread_id, result.conversation_id);
  assert.equal(f.db.prepare("SELECT sent_by FROM outbound_attempts").get().sent_by, "human");
  assert.equal(f.db.prepare("SELECT message_count FROM threads").get().message_count, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM attachments").get().n, 1);
  assert.equal(f.objects.size, 1);
  assert.equal((await f.post(message({ attempt_id: id, subject: "Changed" }, files))).status, 409);
  assert.equal(f.sent.length, 1);
});

test("validates recipient, content, inbox readiness and attachment limits before sending", async (t) => {
  const f = fixture(t);
  for (const [overrides, status] of [
    [{ to: "not-an-email" }, 400], [{ to: "a@example.com,b@example.com" }, 400],
    [{ subject: " " }, 400], [{ subject: "hello\r\nBcc: other@example.com" }, 400],
    [{ text: "" }, 400], [{ mailbox_id: "0" }, 400], [{ mailbox_id: "99" }, 404],
    [{ mailbox_id: "2" }, 409], [{ attempt_id: "mcp-key" }, 400],
    [{ subject: "a".repeat(501) }, 400], [{ text: "a".repeat(100001) }, 400],
  ]) assert.equal((await f.post(message(overrides))).status, status);
  for (const files of [
    [new File([], "empty.txt")],
    Array.from({ length: 11 }, () => new File(["x"], "a.txt")),
    [new File([new Uint8Array(3 * 1024 * 1024 + 1)], "large.bin")],
  ]) assert.equal((await f.post(message({}, files))).status, 400);
  assert.equal((await f.post(message({}, [new File([new Uint8Array(4 * 1024 * 1024)], "oversized.bin")]))).status, 413);
  assert.equal(f.sent.length, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM outbound_attempts").get().n, 0);
});

test("accepts attachment-only messages and rejects cross-origin send attempts", async (t) => {
  const f = fixture(t);
  assert.equal((await f.post(message(), "https://attacker.example")).status, 403);
  assert.equal(f.sent.length, 0);
  assert.equal((await f.post(message({ text: "" }, [new File(["x"], "notes.txt")]))).status, 200);
  assert.equal(f.sent.length, 1);
});

test("a provider failure is terminal for its key and cleans up the empty conversation", async (t) => {
  const f = fixture(t, { fail: true });
  const id = crypto.randomUUID();
  const response = await f.post(message({ attempt_id: id }));
  assert.equal(response.status, 502);
  assert.equal((await response.json()).status, "failed");
  assert.equal((await f.post(message({ attempt_id: id }))).status, 502);
  assert.equal(f.sent.length, 1);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 0);
});

test("a send already in progress returns pending confirmation and does not send twice", async (t) => {
  const f = fixture(t);
  const id = crypto.randomUUID();
  f.db.prepare(`INSERT INTO outbound_attempts (id, mailbox_id, status, to_addresses, subject, text_body, sent_by)
    VALUES (?, 1, 'sending', ?, 'A new conversation', 'Hello from a human', 'human')`)
    .run(`web_compose_${id}`, JSON.stringify(["person@example.com"]));
  const response = await f.post(message({ attempt_id: id }));
  assert.equal(response.status, 202);
  assert.equal((await response.json()).status, "sending");
  assert.equal(f.sent.length, 0);
});

test("the migration keeps MCP sending classified as agent and prevents sender-type reuse", async (t) => {
  const f = fixture(t);
  const intent = { attemptId: "mcp-attempt", mailboxId: 1, to: ["person@example.com"], subject: "Agent message", text: "Hello" };
  await sendNewEmailAttempt(f.env, intent);
  assert.equal(f.db.prepare("SELECT sent_by FROM messages").get().sent_by, "agent");
  assert.equal(f.sent[0].headers["Auto-Submitted"], "auto-generated");
  await assert.rejects(sendNewEmailAttempt(f.env, { ...intent, sentBy: "human" }), /different content/);
});
