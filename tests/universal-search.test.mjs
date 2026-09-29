import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { excerpt, ftsQuery, searchTerms, universalSearchApi } from "../src/worker/api/universal-search.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, snippet, last_message_at, status)
      VALUES (1, 1, 'Refund request', 'Charged twice', '2026-01-02T00:00:00.000Z', 'open'),
             (2, 1, 'Broken invoice', 'VAT missing', '2026-01-01T00:00:00.000Z', 'archived');
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, from_name, subject, text_body)
      VALUES (1, 1, '<a@x>', 'inbound', 'alice@customer.test', 'Alice Customer', 'Refund request',
              'Hi, I was charged twice for order 1234. Please refund the duplicate charge.'),
             (2, 2, '<b@x>', 'inbound', 'dana@finance.test', 'Dana Finance', 'Broken invoice',
              'Our finance team needs the VAT number on invoice 2291.');
    INSERT INTO thread_notes (thread_id, text_body) VALUES (1, 'Called Stripe, refund approved');
    INSERT INTO mail_rules (id, name, conditions, note, forward_to)
      VALUES (1, 'Invoices to accounting',
              '{"match":"all","items":[{"field":"subject","operator":"contains","value":"invoice"}]}',
              NULL, '["books@accounting.test"]');
    INSERT INTO contacts (address, name, company) VALUES ('dana@finance.test', 'Dana Finance', 'Acme Books');
    INSERT INTO contact_addresses (address, contact_id) SELECT 'dana@personal.test', id FROM contacts;`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
    };
  }
  const env = { DB: { prepare: statement } };
  const app = new Hono();
  app.route("/api/search/all", universalSearchApi);
  const search = async (q) => {
    const response = await app.request(`https://mailroom.example/api/search/all?q=${encodeURIComponent(q)}`, {}, env);
    assert.equal(response.status, 200);
    return response.json();
  };
  return { search };
}

test("an empty query finds nothing", async (t) => {
  const { search } = fixture(t);
  assert.deepEqual(await search("   "), {
    conversations: [], notes: [], rules: [], contacts: [],
  });
});

test("message bodies, senders and subjects find conversations", async (t) => {
  const { search } = fixture(t);
  const byBody = await search("duplic");
  assert.deepEqual(byBody.conversations.map((row) => row.id), [1]);
  assert.match(byBody.conversations[0].excerpt, /duplicate charge/);
  assert.equal(byBody.conversations[0].from, "Alice Customer");
  assert.deepEqual((await search("finance.test")).conversations.map((row) => row.id), [2]);
  assert.equal((await search("broken")).conversations[0].status, "archived");
});

test("every word must match", async (t) => {
  const { search } = fixture(t);
  assert.deepEqual((await search("invoice 2291")).conversations.map((row) => row.id), [2]);
  assert.deepEqual((await search("invoice refund")).conversations, []);
});

test("internal notes, rules and contacts are found", async (t) => {
  const { search } = fixture(t);
  const stripe = await search("stripe");
  assert.deepEqual(stripe.notes.map((note) => [note.thread_id, note.thread_subject]), [[1, "Refund request"]]);

  assert.deepEqual((await search("accounting")).rules.map((rule) => [rule.id, rule.excerpt]), [[1, ""]]);
  assert.deepEqual((await search("books@")).rules.map((rule) => rule.excerpt), ["Forwards to books@accounting.test"]);
  assert.deepEqual((await search("acme")).contacts.map((contact) => contact.address), ["dana@finance.test"]);
  assert.deepEqual((await search("personal.test")).contacts.map((contact) => contact.address), ["dana@finance.test"]);
});

test("search syntax and LIKE wildcards are taken literally", async (t) => {
  const { search } = fixture(t);
  for (const q of ['"', "AND", "(", "*", "NEAR(", "-", "%", "_", "a:b"]) {
    const results = await search(q);
    assert.ok(Array.isArray(results.conversations), q);
  }
  assert.deepEqual((await search("%")).contacts, []);
  assert.equal(ftsQuery(["-", "#"]), null);
  assert.equal(ftsQuery(['sa"y', "or"]), '"say"* "or"*');
  assert.deepEqual(searchTerms("  Refund   refund  Order "), ["refund", "order"]);
});

test("excerpts center on the first match", () => {
  const text = `${"x ".repeat(100)}needle here ${"y ".repeat(100)}`;
  const result = excerpt(text, ["needle"]);
  assert.ok(result.startsWith("…"));
  assert.ok(result.endsWith("…"));
  assert.match(result, /needle here/);
  assert.equal(excerpt("Short text", ["zzz"]), "Short text");
});
