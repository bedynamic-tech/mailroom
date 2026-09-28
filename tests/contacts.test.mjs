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

test("contacts API lists contacts A-Z by name, falling back to the address, across pages", async (t) => {
  const f = fixture(t);
  for (const [address, name] of [
    ["zed@example.org", "zed"],
    ["amy@example.org", "Amy"],
    ["bob@example.org", undefined],
    ["carl@example.org", "Carl"],
    ["amy2@example.org", "amy"],
  ]) {
    assert.equal((await f.call("POST", "", { address, name })).status, 201);
  }
  const expected = ["amy@example.org", "amy2@example.org", "bob@example.org", "carl@example.org", "zed@example.org"];
  assert.deepEqual((await f.call("GET", "?sort=name")).body.map((c) => c.address), expected);

  const seen = [];
  let cursor = "";
  for (;;) {
    const page = (await f.call("GET", `?sort=name&limit=2${cursor}`)).body;
    if (page.length === 0) break;
    seen.push(...page.map((c) => c.address));
    const last = page.at(-1);
    const params = new URLSearchParams({ after_address: last.address, after_name: last.name ?? "", after_id: String(last.id) });
    cursor = `&${params}`;
  }
  assert.deepEqual(seen, expected);
});

test("contacts import creates new contacts, fills or overwrites existing ones and reports skips", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 3, from: "new@example.org", at: "2026-04-01T00:00:00.000Z" });
  f.db.prepare("INSERT INTO contacts (address, name, company) VALUES ('old@example.org', 'Kept Name', NULL)").run();

  const first = await f.call("POST", "/import", {
    contacts: [
      { address: "New@Example.org", name: "New Person", notes: "From import" },
      { address: "old@example.org", name: "Imported Name", company: "Imported Co" },
      { address: "new@example.org", name: "Again" },
      { address: "support@example.com", name: "Our inbox" },
      { address: "nope", name: "Bad" },
      { address: "long@example.org", name: "x".repeat(200) },
    ],
  });
  assert.equal(first.status, 200);
  assert.deepEqual(
    { created: first.body.created, updated: first.body.updated, skipped: first.body.skipped },
    { created: 1, updated: 1, skipped: 4 },
  );
  assert.deepEqual(first.body.errors.map((e) => e.error), [
    "Listed more than once",
    "One of this workspace's inboxes",
    "Not a valid email address",
    "name is too long",
  ]);
  const row = (address) => ({ ...f.db.prepare("SELECT name, company, notes, last_seen_at FROM contacts WHERE address = ?").get(address) });
  assert.deepEqual(row("new@example.org"), {
    name: "New Person", company: null, notes: "From import", last_seen_at: "2026-04-01T00:00:00.000Z",
  });
  // Without overwrite, existing details stay and only empty fields are filled.
  assert.deepEqual(row("old@example.org"), { name: "Kept Name", company: "Imported Co", notes: null, last_seen_at: null });

  const second = await f.call("POST", "/import", {
    overwrite: true,
    contacts: [{ address: "old@example.org", name: "Imported Name", company: "" }],
  });
  assert.equal(second.body.updated, 1);
  // Overwrite replaces details, but a blank imported value never clears one.
  assert.deepEqual(row("old@example.org"), { name: "Imported Name", company: "Imported Co", notes: null, last_seen_at: null });

  assert.equal((await f.call("POST", "/import", { contacts: [] })).status, 400);
  assert.equal((await f.call("POST", "/import", {
    contacts: Array.from({ length: 501 }, (_, i) => ({ address: `p${i}@example.org` })),
  })).status, 400);
});

test("migration keeps each existing contact's address as its primary address", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  migrate(db, { before: "0028" });
  db.exec(`INSERT INTO contacts (address, name) VALUES ('ada@example.org', 'Ada'), ('Bob@Example.org', NULL);`);
  db.exec(readFileSync("migrations/0028_contact_addresses.sql", "utf8"));
  assert.deepEqual(
    db.prepare(`SELECT c.address AS primary_address, a.address FROM contact_addresses a
      JOIN contacts c ON c.id = a.contact_id ORDER BY a.address`).all().map((row) => ({ ...row })),
    [
      { primary_address: "ada@example.org", address: "ada@example.org" },
      { primary_address: "Bob@Example.org", address: "bob@example.org" },
    ],
  );
});

test("contacts can have several addresses, and mail from any of them is the contact's", async (t) => {
  const f = fixture(t);
  inbound(f.db, { thread: 1, from: "ada@work.example", at: "2026-03-01T00:00:00.000Z" });
  inbound(f.db, { thread: 2, from: "Ada@Home.example", at: "2026-03-05T00:00:00.000Z" });
  const ada = (await f.call("POST", "", { address: "ada@work.example", name: "Ada" })).body;
  const bob = (await f.call("POST", "", { address: "bob@example.org", name: "Bob" })).body;

  let detail = await f.call("GET", `/${ada.id}`);
  assert.deepEqual(detail.body.addresses, ["ada@work.example"]);
  assert.equal(detail.body.conversation_count, 1);

  // Add a second address and make it primary.
  const updated = await f.call("PATCH", `/${ada.id}`, {
    addresses: [" ADA@home.example ", "ada@work.example", "", "ada@home.example"],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.address, "ada@home.example");
  assert.equal(updated.body.last_seen_at, "2026-03-05T00:00:00.000Z");
  detail = await f.call("GET", `/${ada.id}`);
  assert.deepEqual(detail.body.addresses, ["ada@home.example", "ada@work.example"]);
  assert.equal(detail.body.conversation_count, 2);

  // Either address finds the contact; new mail from either updates it, never a new contact.
  assert.deepEqual((await f.call("GET", "?q=work.example")).body.map((c) => c.id), [ada.id]);
  await recordSender(f.env, { address: "ada@work.example", name: "Ada W", seenAt: "2026-04-01T00:00:00.000Z" });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM contacts").get().n, 2);
  assert.equal(f.db.prepare("SELECT last_seen_at FROM contacts WHERE id = ?").get(ada.id).last_seen_at,
    "2026-04-01T00:00:00.000Z");

  // Creating or importing a secondary address matches the existing contact.
  const duplicate = await f.call("POST", "", { address: "ada@work.example" });
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.id, ada.id);
  const imported = await f.call("POST", "/import", {
    contacts: [{ address: "ada@work.example", company: "Engines" }],
  });
  assert.deepEqual({ created: imported.body.created, updated: imported.body.updated }, { created: 0, updated: 1 });
  assert.equal(f.db.prepare("SELECT company FROM contacts WHERE id = ?").get(ada.id).company, "Engines");

  // Addresses can't be shared with another contact or an inbox, and one is always required.
  const taken = await f.call("PATCH", `/${bob.id}`, { addresses: ["bob@example.org", "ada@work.example"] });
  assert.equal(taken.status, 409);
  assert.equal(taken.body.id, ada.id);
  assert.equal((await f.call("PATCH", `/${bob.id}`, { addresses: ["ADA@home.example"] })).status, 409);
  assert.equal((await f.call("PATCH", `/${bob.id}`, { addresses: ["support@example.com"] })).status, 400);
  assert.equal((await f.call("PATCH", `/${bob.id}`, { addresses: ["", " "] })).status, 400);
  assert.equal((await f.call("PATCH", `/${bob.id}`, { addresses: ["nope"] })).status, 400);

  // Editing an address replaces it; removed addresses are free to use again.
  const renamed = await f.call("PATCH", `/${bob.id}`, { addresses: ["robert@example.org"], name: "Robert" });
  assert.equal(renamed.body.address, "robert@example.org");
  assert.equal(renamed.body.name, "Robert");
  assert.equal((await f.call("POST", "", { address: "bob@example.org" })).status, 201);

  assert.equal((await f.call("DELETE", `/${ada.id}`)).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM contact_addresses WHERE contact_id = ?").get(ada.id).n, 0);
});
