import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockedSendersApi } from "../src/worker/api/blocked-senders.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { blockCandidates, parseBlockPattern } from "../src/shared/blocked-senders.ts";
import { addBlockedSender, matchBlockedSender } from "../src/worker/spam/blocklist.ts";
import {
  blockThreadSender,
  blockThreadSenders,
  BlockThreadSenderError,
} from "../src/worker/spam/block-thread-sender.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'support.acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@support.acme.com', 1);
    INSERT INTO mailboxes (id, address, domain_id) VALUES (2, 'sales@support.acme.com', 1);`);
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
  app.route("/api/blocked-senders", blockedSendersApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/blocked-senders${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call };
}

function inbound(db, { thread, from, mailbox = 1, status = "open", at = "2026-01-01T00:00:00.000Z" }) {
  db.prepare(`INSERT OR IGNORE INTO threads (id, mailbox_id, subject, status, last_message_at)
    VALUES (?, ?, ?, ?, ?)`).run(thread, mailbox, `Subject ${thread}`, status, at);
  db.prepare(`INSERT INTO messages (thread_id, message_id, direction, from_address, created_at)
    VALUES (?, ?, 'inbound', ?, ?)`).run(thread, `<${crypto.randomUUID()}@x>`, from, at);
}

const statusOf = (db, id) => db.prepare("SELECT status FROM threads WHERE id = ?").get(id).status;

test("parseBlockPattern accepts addresses and domain spellings", () => {
  assert.deepEqual(parseBlockPattern(" Spam@Bad.Example "), { kind: "address", pattern: "spam@bad.example" });
  assert.deepEqual(parseBlockPattern("bad.example"), { kind: "domain", pattern: "bad.example" });
  assert.deepEqual(parseBlockPattern("@Bad.Example"), { kind: "domain", pattern: "bad.example" });
  assert.deepEqual(parseBlockPattern("*.bad.example"), { kind: "domain", pattern: "bad.example" });
  for (const value of ["", "com", "bad", "a@b", "not an address", "x@@y.com", 5]) {
    assert.ok("error" in parseBlockPattern(value), `expected ${value} to be rejected`);
  }
});

test("blockCandidates covers the address, its domain and parent domains", () => {
  assert.deepEqual(blockCandidates("A@Mail.Bad.Example"), [
    "a@mail.bad.example",
    "mail.bad.example",
    "bad.example",
  ]);
  assert.deepEqual(blockCandidates("unknown"), []);
});

test("matchBlockedSender matches addresses, domains and subdomains and counts rejections", async (t) => {
  const f = fixture(t);
  await addBlockedSender(f.env, "bad.example", null);
  await addBlockedSender(f.env, "one@spam.test", null);

  assert.equal((await matchBlockedSender(f.env, 1, ["x@bad.example"]))?.pattern, "bad.example");
  assert.equal((await matchBlockedSender(f.env, 1, ["x@deep.mail.bad.example"]))?.pattern, "bad.example");
  assert.equal((await matchBlockedSender(f.env, 2, ["", "ONE@spam.test"], "2026-02-01T00:00:00.000Z"))?.pattern, "one@spam.test");
  assert.equal(await matchBlockedSender(f.env, 1, ["two@spam.test"]), null);
  assert.equal(await matchBlockedSender(f.env, 1, ["x@notbad.example"]), null);
  assert.equal(await matchBlockedSender(f.env, 1, [""]), null);

  const rows = f.db.prepare("SELECT pattern, blocked_count, last_blocked_at FROM blocked_senders ORDER BY pattern").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { pattern: "bad.example", blocked_count: 2, last_blocked_at: rows[0].last_blocked_at },
    { pattern: "one@spam.test", blocked_count: 1, last_blocked_at: "2026-02-01T00:00:00.000Z" },
  ]);
});

test("an inbox rule only blocks mail to that inbox", async (t) => {
  const f = fixture(t);
  const rule = await addBlockedSender(f.env, "bad.example", 1);
  assert.equal(rule.mailbox_id, 1);
  assert.equal(rule.mailbox_address, "help@support.acme.com");
  assert.equal((await matchBlockedSender(f.env, 1, ["x@bad.example"]))?.id, rule.id);
  assert.equal(await matchBlockedSender(f.env, 2, ["x@bad.example"]), null);
});

test("blocked senders API adds, lists, refuses unsafe rules and removes", async (t) => {
  const f = fixture(t);
  const created = await f.call("POST", "", { pattern: "@Bad.Example" });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, "domain");
  assert.equal(created.body.pattern, "bad.example");
  assert.equal(created.body.mailbox_id, null);

  const duplicate = await f.call("POST", "", { pattern: "bad.example" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.id, created.body.id);
  const coveredByAll = await f.call("POST", "", { pattern: "bad.example", mailbox_id: 1 });
  assert.equal(coveredByAll.status, 409);
  assert.match(coveredByAll.body.error, /all inboxes/);

  assert.equal((await f.call("POST", "", { pattern: "gmail.com" })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "acme.com" })).status, 400, "covers an inbox domain");
  assert.equal((await f.call("POST", "", { pattern: "help@support.acme.com" })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "x@y.example", mailbox_id: 99 })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "x@y.example", mailbox_id: "1" })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "someone@gmail.com", mailbox_id: 2 })).status, 201);
  assert.equal((await f.call("POST", "", { pattern: "other.acme.com" })).status, 201);

  const list = await f.call("GET", "");
  assert.deepEqual(
    list.body.map((rule) => [rule.pattern, rule.mailbox_address]).sort(),
    [["bad.example", null], ["other.acme.com", null], ["someone@gmail.com", "sales@support.acme.com"]],
  );

  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 200);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 404);
  assert.equal((await f.call("DELETE", "/abc")).status, 400);
});

test("a rule for all inboxes replaces per-inbox rules for the same sender", async (t) => {
  const f = fixture(t);
  await addBlockedSender(f.env, "spam@bad.example", 1);
  await addBlockedSender(f.env, "spam@bad.example", 2);
  const all = await addBlockedSender(f.env, "spam@bad.example", null);
  assert.deepEqual(
    f.db.prepare("SELECT id, mailbox_id FROM blocked_senders").all().map((row) => ({ ...row })),
    [{ id: all.id, mailbox_id: null }],
  );
});

test("blockThreadSender blocks a domain everywhere and archives their open conversations", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "Promo@News.Bad.Example" });
  inbound(f.db, { thread: 2, from: "other@bad.example", mailbox: 2 });
  inbound(f.db, { thread: 3, from: "customer@good.example" });
  inbound(f.db, { thread: 4, from: "x@notbad.example" });

  const result = await blockThreadSender(f.env, 1, "domain", "all");
  assert.equal(result.blocked.pattern, "news.bad.example");
  assert.equal(result.archived, 1);
  assert.equal(statusOf(f.db, 1), "archived");
  assert.equal(statusOf(f.db, 2), "open", "a parent domain is not blocked by a subdomain rule");

  const again = await blockThreadSender(f.env, 2, "domain", "all");
  assert.equal(again.blocked.pattern, "bad.example");
  assert.equal(again.blocked.mailbox_id, null);
  assert.equal(again.archived, 1);
  assert.equal(statusOf(f.db, 3), "open");
  assert.equal(statusOf(f.db, 4), "open");

  // Blocking a sender that's already blocked reuses the rule.
  inbound(f.db, { thread: 5, from: "other@bad.example" });
  const repeat = await blockThreadSender(f.env, 5, "domain", "inbox");
  assert.equal(repeat.blocked.id, again.blocked.id);
  assert.equal(statusOf(f.db, 5), "archived");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM blocked_senders").get().n, 2);
});

test("blockThreadSender can block one address on the conversation's inbox only", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "spam@bad.example" });
  inbound(f.db, { thread: 3, from: "spam@bad.example", mailbox: 2 });
  inbound(f.db, { thread: 4, from: "friend@bad.example" });

  const result = await blockThreadSender(f.env, 1, "address", "inbox");
  assert.equal(result.blocked.kind, "address");
  assert.equal(result.blocked.mailbox_id, 1);
  assert.equal(result.archived, 2);
  assert.equal(statusOf(f.db, 3), "open", "other inboxes are untouched");
  assert.equal(statusOf(f.db, 4), "open");

  await assert.rejects(blockThreadSender(f.env, 99, "address", "all"), BlockThreadSenderError);
  inbound(f.db, { thread: 6, from: "someone@gmail.com" });
  await assert.rejects(blockThreadSender(f.env, 6, "domain", "all"), /shared by many unrelated people/);
  assert.equal(statusOf(f.db, 6), "open", "a refused block leaves the conversation alone");
});

test("migration keeps existing rules as all-inbox rules", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    if (file >= "0019") continue;
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO blocked_senders (kind, pattern, blocked_count) VALUES ('domain', 'bad.example', 3)`);
  db.exec(readFileSync("migrations/0019_blocked_sender_inbox.sql", "utf8"));
  assert.deepEqual({ ...db.prepare("SELECT pattern, mailbox_id, blocked_count FROM blocked_senders").get() }, {
    pattern: "bad.example",
    mailbox_id: null,
    blocked_count: 3,
  });
});

test("blockThreadSender can block a chosen address on the conversation, such as a Cc", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "customer@good.example" });
  f.db.prepare("UPDATE messages SET cc_addresses = ? WHERE thread_id = 1")
    .run(JSON.stringify(["Pushy@Vendor.example"]));
  inbound(f.db, { thread: 2, from: "pushy@vendor.example" });

  const result = await blockThreadSender(f.env, 1, "address", "inbox", "PUSHY@vendor.example");
  assert.equal(result.blocked.pattern, "pushy@vendor.example");
  assert.equal(statusOf(f.db, 1), "open", "the conversation stays when the blocked address only was copied");
  assert.equal(statusOf(f.db, 2), "archived");

  await assert.rejects(
    blockThreadSender(f.env, 1, "address", "inbox", "stranger@elsewhere.example"),
    /isn't on this conversation/,
  );
  await assert.rejects(
    blockThreadSender(f.env, 1, "address", "inbox", "help@support.acme.com"),
    BlockThreadSenderError,
  );
});

test("blockThreadSenders marks the senders of several conversations as spam and skips the rest", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "Spam@Bad.example" });
  inbound(f.db, { thread: 3, from: "junk@worse.example", mailbox: 2 });
  inbound(f.db, { thread: 4, from: "junk@worse.example" });
  inbound(f.db, { thread: 5, from: "friend@bad.example" });
  inbound(f.db, { thread: 6, from: "sales@support.acme.com" });

  const result = await blockThreadSenders(f.env, [1, 2, 3, 6, 99], "inbox");
  assert.deepEqual(
    result.blocked.map((rule) => [rule.kind, rule.pattern, rule.mailbox_id]),
    [["address", "spam@bad.example", 1], ["address", "junk@worse.example", 2]],
  );
  assert.equal(result.skipped, 2, "own inboxes and missing conversations are skipped");
  assert.equal(statusOf(f.db, 1), "archived");
  assert.equal(statusOf(f.db, 2), "archived");
  assert.equal(statusOf(f.db, 3), "archived");
  assert.equal(statusOf(f.db, 4), "open", "an inbox block leaves other inboxes alone");
  assert.equal(statusOf(f.db, 5), "open");
  assert.equal(statusOf(f.db, 6), "open");

  const everywhere = await blockThreadSenders(f.env, [4], "all");
  assert.equal(everywhere.blocked[0].mailbox_id, null);
  assert.equal(statusOf(f.db, 4), "archived");
});

test("blockThreadSender permanently deletes the sender's conversations when set to", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE global_settings SET blocked_sender_action = 'permanent_delete' WHERE id = 1");
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "spam@bad.example", status: "archived" });
  inbound(f.db, { thread: 3, from: "spam@bad.example", mailbox: 2 });
  inbound(f.db, { thread: 4, from: "friend@good.example" });
  f.db.prepare(`INSERT INTO messages (thread_id, message_id, direction, from_address, raw_key, created_at)
    VALUES (1, '<raw@x>', 'inbound', 'spam@bad.example', 'raw/1.eml', '2026-01-02T00:00:00.000Z')`).run();

  const freed = [];
  const result = await blockThreadSender(f.env, 1, "address", "inbox", undefined, {
    onObjectsFreed: (keys) => freed.push(...keys),
  });
  assert.equal(result.deleted, 2, "open and archived conversations on the inbox are deleted");
  assert.deepEqual(result.deleted_ids, [1, 2]);
  assert.equal(result.archived, 0);
  assert.deepEqual(freed, ["raw/1.eml"]);
  const remaining = f.db.prepare("SELECT id FROM threads ORDER BY id").all().map((row) => row.id);
  assert.deepEqual(remaining, [3, 4], "other inboxes and senders are untouched");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id IN (1, 2)").get().n, 0);
});

test("a conversation still sending is archived instead of deleted", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE global_settings SET blocked_sender_action = 'permanent_delete' WHERE id = 1");
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "spam@bad.example" });
  const sending = f.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'reply_attempts'").get();
  assert.ok(sending, "reply_attempts exists");
  f.db.exec("PRAGMA foreign_keys = OFF");
  const columns = f.db.prepare("PRAGMA table_info(reply_attempts)").all();
  const required = columns.filter((column) => column.notnull && column.dflt_value === null && !column.pk);
  const values = Object.fromEntries(required.map((column) => [column.name, column.type.includes("INT") ? 1 : "x"]));
  values.thread_id = 2;
  values.status = "sending";
  const names = Object.keys(values);
  f.db.prepare(`INSERT INTO reply_attempts (${names.join(", ")}) VALUES (${names.map(() => "?").join(", ")})`)
    .run(...names.map((name) => values[name]));

  const result = await blockThreadSender(f.env, 1, "address", "all");
  assert.deepEqual(result.deleted_ids, [1]);
  assert.equal(result.archived, 1);
  assert.equal(statusOf(f.db, 2), "archived");
});

test("blockThreadSenders deletes in bulk and skips conversations already deleted", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE global_settings SET blocked_sender_action = 'permanent_delete' WHERE id = 1");
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "spam@bad.example" });
  inbound(f.db, { thread: 3, from: "junk@worse.example" });
  inbound(f.db, { thread: 4, from: "friend@good.example" });

  const result = await blockThreadSenders(f.env, [1, 2, 3], "inbox");
  assert.equal(result.blocked.length, 2);
  assert.equal(result.skipped, 0, "a conversation deleted by an earlier block isn't counted as skipped");
  assert.equal(result.deleted, 3);
  assert.deepEqual(f.db.prepare("SELECT id FROM threads").all().map((row) => row.id), [4]);
});

test("the Blocked sender action defaults to archive", async (t) => {
  const f = fixture(t);
  assert.equal(
    f.db.prepare("SELECT blocked_sender_action AS a FROM global_settings WHERE id = 1").get().a,
    "archive",
  );
  assert.throws(() => f.db.exec("UPDATE global_settings SET blocked_sender_action = 'trash' WHERE id = 1"));
});
