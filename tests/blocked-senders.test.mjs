import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { blockedSendersApi } from "../src/worker/api/blocked-senders.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { blockCandidates, parseBlockPattern } from "../src/shared/blocked-senders.ts";
import { addBlockedSender, matchBlockedSender } from "../src/worker/spam/blocklist.ts";
import { reportSpam, SpamReportError } from "../src/worker/spam/report.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'support.acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@support.acme.com', 1);`);
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

function inbound(db, { thread, from, status = "open", at = "2026-01-01T00:00:00.000Z" }) {
  db.prepare(`INSERT OR IGNORE INTO threads (id, mailbox_id, subject, status, last_message_at)
    VALUES (?, 1, ?, ?, ?)`).run(thread, `Subject ${thread}`, status, at);
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
  await addBlockedSender(f.env, "bad.example");
  await addBlockedSender(f.env, "one@spam.test");

  assert.equal((await matchBlockedSender(f.env, ["x@bad.example"]))?.pattern, "bad.example");
  assert.equal((await matchBlockedSender(f.env, ["x@deep.mail.bad.example"]))?.pattern, "bad.example");
  assert.equal((await matchBlockedSender(f.env, ["", "ONE@spam.test"], "2026-02-01T00:00:00.000Z"))?.pattern, "one@spam.test");
  assert.equal(await matchBlockedSender(f.env, ["two@spam.test"]), null);
  assert.equal(await matchBlockedSender(f.env, ["x@notbad.example"]), null);
  assert.equal(await matchBlockedSender(f.env, [""]), null);

  const rows = f.db.prepare("SELECT pattern, blocked_count, last_blocked_at FROM blocked_senders ORDER BY pattern").all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { pattern: "bad.example", blocked_count: 2, last_blocked_at: rows[0].last_blocked_at },
    { pattern: "one@spam.test", blocked_count: 1, last_blocked_at: "2026-02-01T00:00:00.000Z" },
  ]);
});

test("blocked senders API adds, lists, refuses unsafe rules and removes", async (t) => {
  const f = fixture(t);
  const created = await f.call("POST", "", { pattern: "@Bad.Example" });
  assert.equal(created.status, 201);
  assert.equal(created.body.kind, "domain");
  assert.equal(created.body.pattern, "bad.example");

  const duplicate = await f.call("POST", "", { pattern: "bad.example" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.id, created.body.id);

  assert.equal((await f.call("POST", "", { pattern: "gmail.com" })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "acme.com" })).status, 400, "covers an inbox domain");
  assert.equal((await f.call("POST", "", { pattern: "help@support.acme.com" })).status, 400);
  assert.equal((await f.call("POST", "", { pattern: "someone@gmail.com" })).status, 201);
  assert.equal((await f.call("POST", "", { pattern: "other.acme.com" })).status, 201);

  const list = await f.call("GET", "");
  assert.deepEqual(list.body.map((rule) => rule.pattern).sort(), ["bad.example", "other.acme.com", "someone@gmail.com"]);

  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 200);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 404);
  assert.equal((await f.call("DELETE", "/abc")).status, 400);
});

test("reportSpam blocks the sender and archives their open conversations", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "Promo@News.Bad.Example" });
  inbound(f.db, { thread: 2, from: "other@bad.example" });
  inbound(f.db, { thread: 3, from: "customer@good.example" });
  inbound(f.db, { thread: 4, from: "x@notbad.example" });

  const result = await reportSpam(f.env, 1, "domain");
  assert.equal(result.blocked.pattern, "news.bad.example");
  assert.equal(result.archived, 1);
  assert.equal(statusOf(f.db, 1), "archived");
  assert.equal(statusOf(f.db, 2), "open", "a parent domain is not blocked by a subdomain rule");

  const again = await reportSpam(f.env, 2, "domain");
  assert.equal(again.blocked.pattern, "bad.example");
  assert.equal(again.archived, 1);
  assert.equal(statusOf(f.db, 3), "open");
  assert.equal(statusOf(f.db, 4), "open");

  // Reporting a sender that's already blocked reuses the rule.
  inbound(f.db, { thread: 5, from: "other@bad.example" });
  const repeat = await reportSpam(f.env, 5, "domain");
  assert.equal(repeat.blocked.id, again.blocked.id);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM blocked_senders").get().n, 2);
});

test("reportSpam can block one address or only archive", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "spam@bad.example" });
  inbound(f.db, { thread: 2, from: "spam@bad.example" });
  inbound(f.db, { thread: 3, from: "friend@bad.example" });
  inbound(f.db, { thread: 4, from: "who@else.example" });

  const result = await reportSpam(f.env, 1, "address");
  assert.equal(result.blocked.kind, "address");
  assert.equal(result.archived, 2);
  assert.equal(statusOf(f.db, 3), "open");

  const onlyArchive = await reportSpam(f.env, 4, "none");
  assert.deepEqual(onlyArchive, { blocked: null, archived: 1 });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM blocked_senders").get().n, 1);

  await assert.rejects(reportSpam(f.env, 99, "none"), SpamReportError);
  inbound(f.db, { thread: 6, from: "someone@gmail.com" });
  await assert.rejects(reportSpam(f.env, 6, "domain"), /shared by many unrelated people/);
  assert.equal(statusOf(f.db, 6), "open", "a refused block leaves the conversation alone");
});
