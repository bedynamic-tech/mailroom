import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { contactsApi } from "../src/worker/api/contacts.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { parseContactFields, recordSender } from "../src/worker/contacts/contacts.ts";

function migrate(db, { before } = {}) {
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    if (before && file >= before) continue;
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
}

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db);
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);`);
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
  app.route("/api/contacts", contactsApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/contacts${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call };
}

function inbound(db, { thread = 1, from, name = null, at, auto = 0 }) {
  db.prepare(`INSERT OR IGNORE INTO threads (id, mailbox_id, subject, last_message_at)
    VALUES (?, 1, ?, ?)`).run(thread, `Subject ${thread}`, at);
  db.prepare(`INSERT INTO messages (thread_id, message_id, direction, from_address, from_name, created_at, is_auto_submitted)
    VALUES (?, ?, 'inbound', ?, ?, ?, ?)`).run(thread, `<${crypto.randomUUID()}@x>`, from, name, at, auto);
}

test("parseContactFields trims, clears blanks and enforces limits", () => {
  assert.deepEqual(parseContactFields({ name: "  Ada  ", company: "", notes: "a\nb" }), {
    fields: { name: "Ada", company: null, notes: "a\nb" },
  });
  assert.deepEqual(parseContactFields({ name: "x".repeat(121) }), { error: "name is too long" });
  assert.deepEqual(parseContactFields({ phone: 5 }), { error: "phone must be text" });
  assert.deepEqual(parseContactFields({ company: "a\nb" }), { error: "company must be one line" });
});

test("recordSender creates a contact, keeps edited names and advances last seen", async (t) => {
  const f = fixture(t);
  await recordSender(f.env, { address: "Ada@Example.org", name: "Ada L", seenAt: "2026-01-02T00:00:00.000Z" });
  let row = f.db.prepare("SELECT * FROM contacts").get();
  assert.equal(row.address, "ada@example.org");
  assert.equal(row.name, "Ada L");

  f.db.prepare("UPDATE contacts SET name = 'Ada Lovelace'").run();
  await recordSender(f.env, { address: "ada@example.org", name: "Someone else", seenAt: "2026-01-01T00:00:00.000Z" });
  row = f.db.prepare("SELECT * FROM contacts").get();
  assert.equal(row.name, "Ada Lovelace");
  assert.equal(row.last_seen_at, "2026-01-02T00:00:00.000Z");

  await recordSender(f.env, { address: "ada@example.org", name: null, seenAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(f.db.prepare("SELECT last_seen_at FROM contacts").get().last_seen_at, "2026-02-01T00:00:00.000Z");

  await recordSender(f.env, { address: "SUPPORT@example.com", name: "Us", seenAt: "2026-02-01T00:00:00.000Z" });
  await recordSender(f.env, { address: "unknown", name: "Unknown", seenAt: "2026-02-01T00:00:00.000Z" });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 1);
});

test("recordSender only creates contacts for named senders while auto-create is on", async (t) => {
  const f = fixture(t);
  const count = () => f.db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n;
  await recordSender(f.env, { address: "noname@example.org", name: "  ", seenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(count(), 0);

  f.db.prepare("UPDATE global_settings SET auto_create_contacts = 0").run();
  await recordSender(f.env, { address: "named@example.org", name: "Named", seenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(count(), 0);

  // Existing contacts still track new mail while auto-create is off, and gain a name if they lack one.
  f.db.prepare("INSERT INTO contacts (address) VALUES ('manual@example.org')").run();
  await recordSender(f.env, { address: "manual@example.org", name: "Manual Person", seenAt: "2026-03-01T00:00:00.000Z" });
  assert.deepEqual({ ...f.db.prepare("SELECT name, last_seen_at FROM contacts").get() }, {
    name: "Manual Person",
    last_seen_at: "2026-03-01T00:00:00.000Z",
  });

  f.db.prepare("UPDATE global_settings SET auto_create_contacts = 1").run();
  await recordSender(f.env, { address: "named@example.org", name: "Named", seenAt: "2026-01-01T00:00:00.000Z" });
  assert.equal(count(), 2);
});

test("migration backfills external human senders from existing mail", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db, { before: "0017" });
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);`);
  inbound(db, { from: "bob@example.org", name: "Bob", at: "2026-01-01T00:00:00.000Z" });
  inbound(db, { from: "BOB@example.org", name: "Robert", at: "2026-01-03T00:00:00.000Z" });
  inbound(db, { from: "bob@example.org", at: "2026-01-04T00:00:00.000Z" });
  inbound(db, { from: "nameless@example.org", at: "2026-01-02T00:00:00.000Z" });
  inbound(db, { from: "support@example.com", at: "2026-01-02T00:00:00.000Z" });
  inbound(db, { from: "news@example.org", at: "2026-01-02T00:00:00.000Z", auto: 1 });
  inbound(db, { from: "unknown", at: "2026-01-02T00:00:00.000Z" });
  db.exec(readFileSync("migrations/0017_contacts.sql", "utf8"));
  assert.deepEqual(
    db.prepare("SELECT address, name, last_seen_at FROM contacts").all().map((row) => ({ ...row })),
    [{ address: "bob@example.org", name: "Robert", last_seen_at: "2026-01-04T00:00:00.000Z" }],
  );
});

test("contacts API creates, lists, searches, updates and deletes contacts", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 7, from: "carol@example.org", at: "2026-03-01T00:00:00.000Z" });

  const created = await f.call("POST", "", { address: " Carol@Example.org ", name: "Carol", company: "Acme" });
  assert.equal(created.status, 201);
  assert.equal(created.body.address, "carol@example.org");
  assert.equal(created.body.last_seen_at, "2026-03-01T00:00:00.000Z");

  const duplicate = await f.call("POST", "", { address: "CAROL@example.org" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.id, created.body.id);
  assert.equal((await f.call("POST", "", { address: "support@example.com" })).status, 400);
  assert.equal((await f.call("POST", "", { address: "not an address" })).status, 400);

  assert.equal((await f.call("POST", "", { address: "dan@example.net", name: "Dan" })).status, 201);
  assert.equal((await f.call("GET", "")).body.length, 2);
  assert.deepEqual((await f.call("GET", "?q=acme")).body.map((c) => c.name), ["Carol"]);
  assert.deepEqual((await f.call("GET", "?q=%25")).body, []);
  assert.equal((await f.call("GET", "?limit=1")).body.length, 1);

  const detail = await f.call("GET", `/${created.body.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.body.conversation_count, 1);
  assert.equal(detail.body.conversations[0].id, 7);
  assert.equal(detail.body.conversations[0].mailbox_address, "support@example.com");

  const updated = await f.call("PATCH", `/${created.body.id}`, { company: "", notes: "VIP\nPrefers email" });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.company, null);
  assert.equal(updated.body.notes, "VIP\nPrefers email");
  assert.equal(updated.body.name, "Carol");
  assert.equal((await f.call("PATCH", `/${created.body.id}`, { address: "x@y.com" })).status, 400);
  assert.equal((await f.call("PATCH", "/999", { name: "x" })).status, 404);

  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 200);
  assert.equal((await f.call("GET", `/${created.body.id}`)).status, 404);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 404);
});
