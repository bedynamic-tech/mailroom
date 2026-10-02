import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  blockRecipient,
  CatchAllError,
  createInboxFromCatchAll,
  listCatchAllAddresses,
  resolveInboundTarget,
  setDomainCatchAll,
  unblockRecipient,
} from "../src/worker/inbox/catch-all.ts";
import { deleteInbox, purgeInboxObjects } from "../src/worker/inbox/delete.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'acme.com', 'active'), (2, 'other.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@acme.com', 1), (2, 'catchall@acme.com', 1);`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } }; },
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
  return { db, env };
}

function caught(db, { thread, recipient, mailbox = 2, status = "open", at = "2026-01-01T00:00:00.000Z" }) {
  db.prepare(`INSERT INTO threads (id, mailbox_id, catch_all_recipient, subject, status, last_message_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run(thread, mailbox, recipient, `Subject ${thread}`, status, at);
  db.prepare(`INSERT INTO messages (thread_id, message_id, direction, from_address, raw_key, created_at)
    VALUES (?, ?, 'inbound', 'sender@example.com', ?, ?)`).run(thread, `<m${thread}@x>`, `raw/${mailbox}/${thread}.eml`, at);
}

test("mail for an unregistered address is rejected until the domain has a catch-all", async (t) => {
  const { env } = fixture(t);
  assert.equal((await resolveInboundTarget(env, "bitwarden@acme.com")).kind, "unknown");

  await setDomainCatchAll(env, 1, 2);
  const target = await resolveInboundTarget(env, " Bitwarden@Acme.com ");
  assert.equal(target.kind, "caught");
  assert.equal(target.mailbox.id, 2);
  assert.equal(target.catchAllRecipient, "bitwarden@acme.com");

  // An Inbox's own address always wins over the catch-all.
  const own = await resolveInboundTarget(env, "help@acme.com");
  assert.equal(own.kind, "inbox");
  assert.equal(own.mailbox.id, 1);
  assert.equal(own.catchAllRecipient, null);

  // Other domains are unaffected.
  assert.equal((await resolveInboundTarget(env, "anyone@other.com")).kind, "unknown");
});

test("each domain has at most one catch-all inbox, which must be on that domain", async (t) => {
  const { env, db } = fixture(t);
  const catchAllOf = () => db.prepare("SELECT catch_all_mailbox_id AS id FROM domains WHERE id = 1").get().id;
  await setDomainCatchAll(env, 1, 2);
  await setDomainCatchAll(env, 1, 1);
  assert.equal(catchAllOf(), 1);
  await setDomainCatchAll(env, 1, null);
  assert.equal(catchAllOf(), null);
  await assert.rejects(setDomainCatchAll(env, 2, 1), (error) => error instanceof CatchAllError && error.status === 400);
  await assert.rejects(setDomainCatchAll(env, 99, null), (error) => error instanceof CatchAllError && error.status === 404);
});

test("a catch-all can archive what it catches, and turning it off clears that", async (t) => {
  const { env, db } = fixture(t);
  await setDomainCatchAll(env, 1, 2);
  assert.equal((await resolveInboundTarget(env, "news@acme.com")).archive, false);

  await setDomainCatchAll(env, 1, 2, true);
  const target = await resolveInboundTarget(env, "news@acme.com");
  assert.equal(target.kind, "caught");
  assert.equal(target.archive, true);
  assert.deepEqual(Object.keys(target.mailbox).sort(), ["address", "agent_mode", "id"]);

  await setDomainCatchAll(env, 1, null, true);
  assert.equal(db.prepare("SELECT catch_all_archive AS a FROM domains WHERE id = 1").get().a, 0);
});

test("blocking an address rejects its mail, counts it and archives its open conversations", async (t) => {
  const { env, db } = fixture(t);
  await setDomainCatchAll(env, 1, 2);
  caught(db, { thread: 1, recipient: "leaked@acme.com" });
  caught(db, { thread: 2, recipient: "leaked@acme.com", status: "archived" });
  caught(db, { thread: 3, recipient: "bitwarden@acme.com", at: "2026-01-02T00:00:00.000Z" });

  const result = await blockRecipient(env, "Leaked@Acme.com");
  assert.equal(result.blocked.address, "leaked@acme.com");
  assert.equal(result.archived, 1);
  assert.equal(db.prepare("SELECT status FROM threads WHERE id = 3").get().status, "open");

  const target = await resolveInboundTarget(env, "leaked@acme.com", "2026-02-01T00:00:00.000Z");
  assert.deepEqual(target, { kind: "blocked", ruleId: result.blocked.id });
  const rule = db.prepare("SELECT blocked_count, last_blocked_at FROM blocked_recipients").get();
  assert.equal(rule.blocked_count, 1);
  assert.equal(rule.last_blocked_at, "2026-02-01T00:00:00.000Z");

  // Blocking again keeps the one rule.
  assert.equal((await blockRecipient(env, "leaked@acme.com")).blocked.id, result.blocked.id);

  const addresses = await listCatchAllAddresses(env, 2);
  assert.deepEqual(
    addresses.map((row) => [row.address, row.conversation_count, row.blocked_id]),
    [["bitwarden@acme.com", 1, null], ["leaked@acme.com", 2, result.blocked.id]],
  );

  assert.equal(await unblockRecipient(env, result.blocked.id), true);
  assert.equal((await resolveInboundTarget(env, "leaked@acme.com")).kind, "caught");
});

test("an inbox address or an address off the workspace's domains cannot be blocked", async (t) => {
  const { env } = fixture(t);
  await assert.rejects(blockRecipient(env, "help@acme.com"), (error) => error.status === 409);
  await assert.rejects(blockRecipient(env, "someone@gmail.com"), (error) => error.status === 400);
  await assert.rejects(blockRecipient(env, "not an address"), (error) => error.status === 400);
});

test("creating an inbox from a caught address can move its conversations over", async (t) => {
  const { env, db } = fixture(t);
  await setDomainCatchAll(env, 1, 2);
  caught(db, { thread: 1, recipient: "bitwarden@acme.com" });
  caught(db, { thread: 2, recipient: "bitwarden@acme.com" });
  caught(db, { thread: 3, recipient: "github@acme.com" });
  db.exec(`INSERT INTO labels (id, mailbox_id, name, condition) VALUES (1, 2, 'Security', 'x');
    INSERT INTO thread_labels (thread_id, label_id) VALUES (1, 1), (3, 1);
    INSERT INTO blocked_recipients (address) VALUES ('bitwarden@acme.com');`);

  const created = await createInboxFromCatchAll(env, { address: "Bitwarden@acme.com", moveConversations: true });
  assert.equal(created.mailbox.address, "bitwarden@acme.com");
  assert.equal(created.moved, 2);
  const moved = db.prepare("SELECT id, mailbox_id, catch_all_recipient FROM threads ORDER BY id").all();
  assert.deepEqual(moved.map((row) => ({ ...row })), [
    { id: 1, mailbox_id: created.mailbox.id, catch_all_recipient: null },
    { id: 2, mailbox_id: created.mailbox.id, catch_all_recipient: null },
    { id: 3, mailbox_id: 2, catch_all_recipient: "github@acme.com" },
  ]);
  // The catch-all's Labels don't follow; the unmoved conversation keeps its own.
  assert.deepEqual(db.prepare("SELECT thread_id FROM thread_labels").all().map((row) => row.thread_id), [3]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM blocked_recipients").get().n, 0);

  // New mail now reaches the new inbox directly.
  const target = await resolveInboundTarget(env, "bitwarden@acme.com");
  assert.equal(target.kind, "inbox");
  assert.equal(target.mailbox.id, created.mailbox.id);

  await assert.rejects(
    createInboxFromCatchAll(env, { address: "bitwarden@acme.com", moveConversations: false }),
    (error) => error instanceof CatchAllError && error.status === 409,
  );
});

test("creating an inbox without moving leaves caught conversations in the catch-all", async (t) => {
  const { env, db } = fixture(t);
  caught(db, { thread: 1, recipient: "github@acme.com" });
  const created = await createInboxFromCatchAll(env, { address: "github@acme.com", moveConversations: false });
  assert.equal(created.moved, 0);
  assert.equal(db.prepare("SELECT mailbox_id FROM threads WHERE id = 1").get().mailbox_id, 2);
});

test("deleting the catch-all inbox keeps files of conversations moved out of it", async (t) => {
  const { env, db } = fixture(t);
  await setDomainCatchAll(env, 1, 2);
  caught(db, { thread: 1, recipient: "bitwarden@acme.com" });
  caught(db, { thread: 2, recipient: "spam@acme.com" });
  await createInboxFromCatchAll(env, { address: "bitwarden@acme.com", moveConversations: true });

  await deleteInbox(env, { id: 2, confirmAddress: "catchall@acme.com" });
  assert.equal(db.prepare("SELECT catch_all_mailbox_id AS id FROM domains WHERE id = 1").get().id, null);

  const keys = new Set(["raw/2/1.eml", "raw/2/2.eml"]);
  const bucket = {
    async list({ prefix }) {
      return { objects: [...keys].filter((key) => key.startsWith(prefix)).map((key) => ({ key })), truncated: false };
    },
    async delete(list) { for (const key of list) keys.delete(key); },
  };
  await purgeInboxObjects(bucket, 2, env.DB);
  assert.deepEqual([...keys], ["raw/2/1.eml"]);
});
