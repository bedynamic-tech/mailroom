import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { threadNotesApi } from "../src/worker/api/thread-notes.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { deleteArchivedConversations } from "../src/worker/inbox/delete-conversations.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, last_message_at, status)
      VALUES (1, 1, 'Refund request', '2026-01-01T00:00:00.000Z', 'open'),
             (2, 1, 'Broken invoice', '2026-01-02T00:00:00.000Z', 'archived');`);
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
    RAW: { async delete() {} },
  };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/threads", threadNotesApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/threads${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call };
}

test("an internal note is saved with sanitized rich text and a plain-text copy", async (t) => {
  const f = fixture(t);
  const { status, body } = await f.call("POST", "/1/notes", {
    text: "ignored",
    html: '<p>Called them, <b>refund</b> approved<script>alert(1)</script></p>',
  });
  assert.equal(status, 201);
  assert.equal(body.thread_id, 1);
  assert.equal(body.html_body.includes("<script"), false);
  assert.match(body.html_body, /<b>refund<\/b>/);
  assert.equal(body.text_body, "Called them, refund approved");
});

test("an internal note never touches the conversation's messages or ordering", async (t) => {
  const f = fixture(t);
  await f.call("POST", "/1/notes", { text: "Customer is a VIP", html: "" });
  const thread = f.db.prepare("SELECT message_count, snippet, last_message_at, is_read FROM threads WHERE id = 1").get();
  assert.deepEqual({ ...thread }, {
    message_count: 0,
    snippet: "",
    last_message_at: "2026-01-01T00:00:00.000Z",
    is_read: 0,
  });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 0);
});

test("blank notes, oversized notes and unknown conversations are rejected", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call("POST", "/1/notes", { text: "  ", html: "<p><br></p>" })).status, 400);
  assert.equal((await f.call("POST", "/1/notes", { text: "x".repeat(20_001) })).status, 400);
  assert.equal((await f.call("POST", "/99/notes", { text: "hello" })).status, 404);
  assert.equal((await f.call("POST", "/abc/notes", { text: "hello" })).status, 400);
});

test("a note can be deleted only through its own conversation", async (t) => {
  const f = fixture(t);
  const { body: note } = await f.call("POST", "/1/notes", { text: "Follow up Friday" });
  assert.equal((await f.call("DELETE", `/2/notes/${note.id}`)).status, 404);
  assert.deepEqual((await f.call("DELETE", `/1/notes/${note.id}`)).body, { ok: true });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM thread_notes").get().n, 0);
});

test("deleting an archived conversation deletes its notes", async (t) => {
  const f = fixture(t);
  await f.call("POST", "/2/notes", { text: "Duplicate of #1" });
  await f.call("POST", "/1/notes", { text: "Keep me" });
  await deleteArchivedConversations(f.env, { ids: [2] });
  const left = f.db.prepare("SELECT thread_id, text_body FROM thread_notes").all().map((row) => ({ ...row }));
  assert.deepEqual(left, [{ thread_id: 1, text_body: "Keep me" }]);
});

test("only the notes API and deletions touch the notes table", () => {
  // Guards against a send, quote, forward, draft, notification or MCP path
  // ever picking up an Internal Note.
  const allowed = new Set([
    "src/worker/api/thread-notes.ts",
    // Mail Rules only insert notes; forwards never read them.
    "src/worker/email/mail-rules.ts",
    // The web app's universal search reads notes only to show them to people.
    "src/worker/api/universal-search.ts",
    "src/worker/inbox/delete.ts",
    "src/worker/inbox/delete-conversations.ts",
  ]);
  const found = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && readFileSync(path, "utf8").includes("thread_notes")) found.push(path);
    }
  };
  walk("src/worker");
  walk("src/mcp");
  walk("src/shared");
  assert.deepEqual(found.filter((path) => !allowed.has(path)), []);
});
