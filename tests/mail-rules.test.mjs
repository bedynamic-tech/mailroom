import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mailRulesApi } from "../src/worker/api/mail-rules.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { fromMatches, mailRuleMatches, parseMailRuleInput } from "../src/shared/mail-rules.ts";
import { applyMailRules, createMailRule, matchingMailRules } from "../src/worker/email/mail-rules.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'support.acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@support.acme.com', 1);
    INSERT INTO mailboxes (id, address, domain_id) VALUES (2, 'sales@support.acme.com', 1);
    INSERT INTO labels (id, mailbox_id, name, condition) VALUES (1, 1, 'Invoices', 'An invoice');
    INSERT INTO labels (id, mailbox_id, name, condition) VALUES (2, 2, 'Leads', 'A lead');
    INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (10, 1, 'Invoice 42', '2026-01-01T00:00:00.000Z');
    INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (20, 2, 'Invoice 43', '2026-01-01T00:00:00.000Z');`);
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
  app.route("/api/mail-rules", mailRulesApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/mail-rules${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call };
}

const message = (overrides = {}) => ({
  fromAddress: "billing@mail.vendor.com",
  fromName: "Vendor Billing",
  subject: "Your Invoice #42",
  body: "Please find the invoice attached.",
  attachmentCount: 1,
  ...overrides,
});

const thread = (db, id) => ({ ...db.prepare("SELECT status, is_read FROM threads WHERE id = ?").get(id) });
const threadLabels = (db, id) =>
  db.prepare("SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id").all(id).map((row) => row.label_id);

test("parseMailRuleInput normalizes and requires a condition and an action", () => {
  const parsed = parseMailRuleInput({
    name: "  Invoices ",
    mailbox_id: 1,
    from_pattern: " vendor.com ",
    subject_contains: "  ",
    has_attachment: true,
    label_id: 1,
  });
  assert.equal(parsed.name, "Invoices");
  assert.equal(parsed.from_pattern, "vendor.com");
  assert.equal(parsed.subject_contains, null);
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.archive, false);

  assert.match(parseMailRuleInput({ name: "x", archive: true }).error, /condition/);
  assert.match(parseMailRuleInput({ name: "x", from_pattern: "a" }).error, /action/);
  assert.match(parseMailRuleInput({ name: "", from_pattern: "a", archive: true }).error, /name/);
  assert.match(parseMailRuleInput({ name: "x", from_pattern: "a", label_id: 1 }).error, /one inbox/);
  assert.match(parseMailRuleInput({ name: "x", from_pattern: "a", archive: "yes" }).error, /archive/);
  assert.match(parseMailRuleInput({ name: "x", from_pattern: "a".repeat(201), archive: true }).error, /at most/);
  assert.ok("error" in parseMailRuleInput(null));
});

test("fromMatches handles addresses, domains with subdomains, and name text", () => {
  assert.ok(fromMatches("billing@mail.vendor.com", "Billing@Mail.Vendor.com".toLowerCase(), null));
  assert.ok(!fromMatches("billing@vendor.com", "billing@mail.vendor.com", null));
  assert.ok(fromMatches("vendor.com", "billing@mail.vendor.com", null));
  assert.ok(fromMatches("@vendor.com", "billing@vendor.com", null));
  assert.ok(!fromMatches("vendor.com", "billing@notvendor.com", null));
  assert.ok(fromMatches("stripe", "receipts@example.com", "Stripe Receipts"));
  assert.ok(fromMatches("receipts", "receipts@example.com", null));
  assert.ok(!fromMatches("stripe", "receipts@example.com", null));
});

test("mailRuleMatches requires every condition that is set", () => {
  const rule = { from_pattern: "vendor.com", subject_contains: "invoice", body_contains: null, has_attachment: true };
  assert.ok(mailRuleMatches(rule, message()));
  assert.ok(!mailRuleMatches(rule, message({ attachmentCount: 0 })));
  assert.ok(!mailRuleMatches(rule, message({ subject: "Hello" })));
  assert.ok(!mailRuleMatches(rule, message({ fromAddress: "x@other.com" })));
  assert.ok(mailRuleMatches({ ...rule, has_attachment: false, body_contains: "ATTACHED" }, message({ attachmentCount: 0 })));
});

test("applyMailRules labels, archives, marks read, counts, and reports skips", async (t) => {
  const f = fixture(t);
  const invoices = await createMailRule(f.env, {
    name: "Invoices", mailbox_id: 1, from_pattern: "vendor.com", has_attachment: true,
    label_id: 1, archive: true, skip_draft: true,
  });
  const everywhere = await createMailRule(f.env, {
    name: "Quiet invoices", subject_contains: "invoice", mark_read: true, skip_notifications: true,
  });
  await createMailRule(f.env, { name: "Off", subject_contains: "invoice", archive: true, enabled: false });
  await createMailRule(f.env, { name: "Other inbox", mailbox_id: 2, subject_contains: "invoice", label_id: 2 });

  const applied = await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message() }, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(applied, { ruleIds: [invoices.id, everywhere.id], skipDraft: true, skipNotifications: true });
  assert.deepEqual(thread(f.db, 10), { status: "archived", is_read: 1 });
  assert.deepEqual(threadLabels(f.db, 10), [1]);
  const counts = f.db.prepare("SELECT name, match_count, last_matched_at FROM mail_rules ORDER BY id").all();
  assert.deepEqual(counts.map((row) => [row.name, row.match_count]), [
    ["Invoices", 1], ["Quiet invoices", 1], ["Off", 0], ["Other inbox", 0],
  ]);
  assert.equal(counts[0].last_matched_at, "2026-02-01T00:00:00.000Z");

  const none = await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message({ subject: "Hi", attachmentCount: 0 }) });
  assert.deepEqual(none, { ruleIds: [], skipDraft: false, skipNotifications: false });

  assert.deepEqual((await matchingMailRules(f.env, 2, message())).map((rule) => rule.name), ["Quiet invoices", "Other inbox"]);
  assert.equal(f.db.prepare("SELECT match_count FROM mail_rules WHERE name = 'Other inbox'").get().match_count, 0);
});

test("mail rules API creates, lists, validates, updates, and deletes", async (t) => {
  const f = fixture(t);
  const created = await f.call("POST", "", {
    name: "Invoices", mailbox_id: 1, from_pattern: "vendor.com", label_id: 1, archive: true,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.label_name, "Invoices");
  assert.equal(created.body.mailbox_address, "help@support.acme.com");
  assert.equal(created.body.archive, true);
  assert.equal(created.body.mark_read, false);

  const wrongLabel = await f.call("POST", "", { name: "x", mailbox_id: 1, from_pattern: "a", label_id: 2 });
  assert.equal(wrongLabel.status, 400);
  const missingInbox = await f.call("POST", "", { name: "x", mailbox_id: 99, from_pattern: "a", archive: true });
  assert.equal(missingInbox.status, 400);
  const noAction = await f.call("POST", "", { name: "x", from_pattern: "a" });
  assert.equal(noAction.status, 400);

  const updated = await f.call("PUT", `/${created.body.id}`, {
    name: "Invoices", mailbox_id: 1, from_pattern: "vendor.com", label_id: 1, archive: true, enabled: false,
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.enabled, false);
  assert.equal((await f.call("PUT", "/999", { name: "x", from_pattern: "a", archive: true })).status, 404);

  const listed = await f.call("GET", "");
  assert.deepEqual(listed.body.map((rule) => rule.id), [created.body.id]);

  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 200);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 404);
  assert.equal((await f.call("DELETE", "/abc")).status, 400);
});

test("deleting an inbox's label or the inbox itself keeps rules consistent", async (t) => {
  const f = fixture(t);
  const rule = await createMailRule(f.env, { name: "Label", mailbox_id: 1, subject_contains: "x", label_id: 1 });
  f.db.exec("DELETE FROM thread_labels WHERE label_id = 1; DELETE FROM labels WHERE id = 1");
  assert.equal(f.db.prepare("SELECT label_id FROM mail_rules WHERE id = ?").get(rule.id).label_id, null);
  f.db.exec("DELETE FROM threads WHERE mailbox_id = 1; DELETE FROM mailboxes WHERE id = 1");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM mail_rules").get().count, 0);
});
