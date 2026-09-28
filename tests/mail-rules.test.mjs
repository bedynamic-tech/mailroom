import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { mailRulesApi } from "../src/worker/api/mail-rules.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import {
  conditionMatches,
  describeMailRuleConditions,
  mailRuleMatches,
  parseMailRuleInput,
} from "../src/shared/mail-rules.ts";
import { applyMailRules, createMailRule, matchingMailRules } from "../src/worker/email/mail-rules.ts";
import { buildForward, sendRuleForward } from "../src/worker/email/rule-forward.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'support.acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id, display_name) VALUES (1, 'help@support.acme.com', 1, 'Acme Help');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (2, 'sales@support.acme.com', 1);
    INSERT INTO labels (id, mailbox_id, name, condition) VALUES (1, 1, 'Invoices', 'An invoice');
    INSERT INTO labels (id, mailbox_id, name, condition) VALUES (2, 2, 'Leads', 'A lead');
    INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (10, 1, 'Invoice 42', '2026-01-01T00:00:00.000Z');
    INSERT INTO threads (id, mailbox_id, subject, last_message_at) VALUES (20, 2, 'Invoice 43', '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (id, thread_id, message_id, direction, from_address) VALUES (100, 10, '<a@x>', 'inbound', 'billing@vendor.com');
    INSERT INTO messages (id, thread_id, message_id, direction, from_address) VALUES (101, 10, '<b@x>', 'inbound', 'billing@vendor.com');`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
    };
  }
  const sent = [];
  const env = {
    DB: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try { const results = []; for (const item of statements) results.push(await item.run()); db.exec("COMMIT"); return results; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
    EMAIL: {
      failWith: null,
      async send(message) {
        if (this.failWith) throw new Error(this.failWith);
        sent.push(message);
        return { messageId: `sent-${sent.length}@provider` };
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
  return { db, env, call, sent };
}

const message = (overrides = {}) => ({
  from: { address: "billing@mail.vendor.com", name: "Vendor Billing" },
  to: [{ address: "help@support.acme.com", name: null }],
  cc: [{ address: "boss@acme.com", name: "The Boss" }],
  subject: "Your Invoice #42",
  body: "Please find the invoice attached.",
  attachmentNames: ["invoice-42.PDF"],
  ...overrides,
});

const c = (field, operator, value = "") => ({ field, operator, value });
const all = (...items) => ({ match: "all", items });
const any = (...items) => ({ match: "any", items });

const thread = (db, id) => ({ ...db.prepare("SELECT status, is_read FROM threads WHERE id = ?").get(id) });
const threadLabels = (db, id) =>
  db.prepare("SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id").all(id).map((row) => row.label_id);

test("parseMailRuleInput validates conditions, groups and forward recipients", () => {
  const parsed = parseMailRuleInput({
    name: "  Invoices ",
    mailbox_id: 1,
    conditions: all(c("from", "domain_is", " @Vendor.com "), { match: "any", conditions: [c("subject", "contains", " invoice "), c("has_attachment", "yes", "ignored")] }),
    label_id: 1,
    forward_to: ["Accounting@Example.com", " "],
    forward_cc: ["accounting@example.com", "boss@example.com"],
  });
  assert.equal(parsed.name, "Invoices");
  assert.deepEqual(parsed.conditions, all(c("from", "domain_is", "vendor.com"), { match: "any", conditions: [c("subject", "contains", "invoice"), c("has_attachment", "yes")] }));
  assert.deepEqual(parsed.forward_to, ["Accounting@example.com"]);
  assert.deepEqual(parsed.forward_cc, ["boss@example.com"]);
  assert.deepEqual(parsed.forward_bcc, []);

  const base = { name: "x", archive: true, conditions: all(c("subject", "contains", "a")) };
  assert.match(parseMailRuleInput({ ...base, conditions: all() }).error, /at least one condition/);
  assert.match(parseMailRuleInput({ ...base, conditions: { match: "most", items: [c("subject", "contains", "a")] } }).error, /all or any/);
  assert.match(parseMailRuleInput({ ...base, conditions: all({ match: "any", conditions: [] }) }).error, /group can't be empty/);
  assert.match(parseMailRuleInput({ ...base, conditions: all(c("body", "starts_with", "a")) }).error, /how to compare/);
  assert.match(parseMailRuleInput({ ...base, conditions: all(c("nope", "is", "a")) }).error, /field/);
  assert.match(parseMailRuleInput({ ...base, conditions: all(c("subject", "contains", " ")) }).error, /Fill in/);
  assert.match(parseMailRuleInput({ ...base, conditions: all(c("to", "domain_is", "a@b.com")) }).error, /domain/);
  assert.match(parseMailRuleInput({ ...base, conditions: all(...Array.from({ length: 21 }, () => c("subject", "contains", "a"))) }).error, /at most 20/);
  assert.match(parseMailRuleInput({ ...base, archive: false }).error, /action/);
  assert.match(parseMailRuleInput({ ...base, label_id: 1 }).error, /one inbox/);
  assert.match(parseMailRuleInput({ ...base, forward_to: ["not an address"] }).error, /valid email/);
  assert.match(parseMailRuleInput({ ...base, archive: false, forward_cc: ["a@b.com"] }).error, /To address/);
  assert.ok(!("error" in parseMailRuleInput({ ...base, archive: false, forward_to: ["a@b.com"] })));
});

test("conditionMatches covers every operator and address field", () => {
  const m = message();
  assert.ok(conditionMatches(c("from", "contains", "vendor billing"), m));
  assert.ok(conditionMatches(c("from", "is", "billing@mail.vendor.com"), m));
  assert.ok(conditionMatches(c("from", "domain_is", "vendor.com"), m));
  assert.ok(!conditionMatches(c("from", "domain_is", "mail.vendor.co"), m));
  assert.ok(conditionMatches(c("from", "starts_with", "billing@"), m));
  assert.ok(conditionMatches(c("from", "is_not", "someone@else.com"), m));
  assert.ok(!conditionMatches(c("from", "not_contains", "vendor"), m));
  assert.ok(conditionMatches(c("to", "is", "help@support.acme.com"), m));
  assert.ok(conditionMatches(c("cc", "contains", "boss"), m));
  assert.ok(conditionMatches(c("cc", "domain_is", "acme.com"), m));
  assert.ok(!conditionMatches(c("cc", "contains", "boss"), message({ cc: [] })));
  assert.ok(conditionMatches(c("cc", "not_contains", "boss"), message({ cc: [] })));
  assert.ok(conditionMatches(c("subject", "ends_with", "#42"), m));
  assert.ok(conditionMatches(c("body", "not_contains", "refund"), m));
  assert.ok(conditionMatches(c("attachment_name", "ends_with", ".pdf"), m));
  assert.ok(conditionMatches(c("has_attachment", "yes"), m));
  assert.ok(conditionMatches(c("has_attachment", "no"), message({ attachmentNames: [] })));
  assert.ok(!conditionMatches(c("has_attachment", "yes"), message({ attachmentNames: [] })));
});

test("mailRuleMatches combines AND, OR and groups", () => {
  // From is at vendor.com AND (subject contains invoice OR attachment ends with .pdf)
  const rule = all(c("from", "domain_is", "vendor.com"), { match: "any", conditions: [c("subject", "contains", "invoice"), c("attachment_name", "ends_with", ".pdf")] });
  assert.ok(mailRuleMatches(rule, message()));
  assert.ok(mailRuleMatches(rule, message({ subject: "Hello" })));
  assert.ok(!mailRuleMatches(rule, message({ subject: "Hello", attachmentNames: [] })));
  assert.ok(!mailRuleMatches(rule, message({ from: { address: "x@other.com", name: null } })));

  const either = any(c("from", "is", "a@b.com"), c("subject", "contains", "urgent"));
  assert.ok(mailRuleMatches(either, message({ subject: "URGENT: help" })));
  assert.ok(!mailRuleMatches(either, message()));
  assert.ok(!mailRuleMatches(all(), message()), "a rule without conditions matches nothing");

  assert.equal(
    describeMailRuleConditions(rule),
    "From is at domain “vendor.com” and (Subject contains “invoice” or Attachment name ends with “.pdf”)",
  );
});

test("applyMailRules labels, archives, marks read, counts, reports skips and forwards", async (t) => {
  const f = fixture(t);
  const invoices = await createMailRule(f.env, {
    name: "Invoices", mailbox_id: 1, conditions: all(c("from", "domain_is", "vendor.com"), c("has_attachment", "yes")),
    label_id: 1, archive: true, skip_draft: true, forward_to: ["accounting@example.com"], forward_bcc: ["audit@example.com"],
  });
  const everywhere = await createMailRule(f.env, {
    name: "Quiet invoices", conditions: all(c("subject", "contains", "invoice")), mark_read: true, skip_notifications: true,
  });
  await createMailRule(f.env, { name: "Off", conditions: all(c("subject", "contains", "invoice")), archive: true, enabled: false });
  await createMailRule(f.env, { name: "Other inbox", mailbox_id: 2, conditions: all(c("subject", "contains", "invoice")), label_id: 2 });

  const applied = await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message() }, "2026-02-01T00:00:00.000Z");
  assert.deepEqual(applied, {
    ruleIds: [invoices.id, everywhere.id],
    skipDraft: true,
    skipNotifications: true,
    forwards: [{ ruleId: invoices.id, to: ["accounting@example.com"], cc: [], bcc: ["audit@example.com"] }],
  });
  assert.deepEqual(thread(f.db, 10), { status: "archived", is_read: 1 });
  assert.deepEqual(threadLabels(f.db, 10), [1]);
  const counts = f.db.prepare("SELECT name, match_count, last_matched_at FROM mail_rules ORDER BY id").all();
  assert.deepEqual(counts.map((row) => [row.name, row.match_count]), [
    ["Invoices", 1], ["Quiet invoices", 1], ["Off", 0], ["Other inbox", 0],
  ]);
  assert.equal(counts[0].last_matched_at, "2026-02-01T00:00:00.000Z");

  const none = await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message({ subject: "Hi", attachmentNames: [] }) });
  assert.deepEqual(none, { ruleIds: [], skipDraft: false, skipNotifications: false, forwards: [] });

  assert.deepEqual((await matchingMailRules(f.env, 2, message())).map((rule) => rule.name), ["Quiet invoices", "Other inbox"]);
});

test("a board item rule adds one card per conversation, titled from the subject", async (t) => {
  const f = fixture(t);
  const doing = f.db.prepare("SELECT id FROM board_columns WHERE name = 'In progress'").get().id;
  const rule = await createMailRule(f.env, { name: "Track invoices", conditions: all(c("subject", "contains", "invoice")), board_column_id: doing });
  assert.equal(rule.board_column_id, doing);
  assert.equal(rule.board_column_name, "In progress");
  assert.equal((await f.call("POST", "", { name: "x", conditions: all(c("subject", "contains", "x")), board_column_id: 999 })).status, 400);

  await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message({ subject: "Re: Your Invoice #42" }) });
  await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message({ subject: "Re: Your Invoice #42" }) });
  const cards = f.db.prepare("SELECT c.column_id, c.title, t.thread_id FROM board_cards c JOIN board_card_threads t ON t.card_id = c.id").all();
  assert.deepEqual(cards.map((row) => ({ ...row })), [{ column_id: doing, title: "Your Invoice #42", thread_id: 10 }]);

  f.db.exec(`DELETE FROM board_columns WHERE id = ${doing}`);
  await applyMailRules(f.env, { mailboxId: 2, threadId: 20, message: message() });
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM board_card_threads WHERE thread_id = 20").get().n, 0);
});

test("a note rule adds its text as an internal note each time an email matches", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call("POST", "", { name: "x", conditions: all(c("subject", "contains", "x")), note: "   " })).status, 400);
  assert.equal((await f.call("POST", "", { name: "x", conditions: all(c("subject", "contains", "x")), note: "n".repeat(2001) })).status, 400);
  const vip = await createMailRule(f.env, { name: "VIP", conditions: all(c("subject", "contains", "invoice")), note: "  VIP customer.\r\nReply fast.  " });
  assert.equal(vip.note, "VIP customer.\nReply fast.");
  await createMailRule(f.env, { name: "Plain", conditions: all(c("subject", "contains", "invoice")), mark_read: true });

  const applied = await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message() }, "2026-09-28T10:00:00.000Z");
  assert.deepEqual(applied.forwards, []);
  await applyMailRules(f.env, { mailboxId: 1, threadId: 10, message: message() }, "2026-09-28T11:00:00.000Z");
  const notes = f.db.prepare("SELECT thread_id, text_body, html_body, mail_rule_id, created_at FROM thread_notes ORDER BY id").all();
  assert.deepEqual(notes.map((row) => ({ ...row })), [
    { thread_id: 10, text_body: "VIP customer.\nReply fast.", html_body: null, mail_rule_id: vip.id, created_at: "2026-09-28T10:00:00.000Z" },
    { thread_id: 10, text_body: "VIP customer.\nReply fast.", html_body: null, mail_rule_id: vip.id, created_at: "2026-09-28T11:00:00.000Z" },
  ]);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE thread_id = 10").get().n, 2);
});

const original = (overrides = {}) => ({
  from: { address: "billing@vendor.com", name: "Vendor Billing" },
  replyTo: "billing@vendor.com",
  to: [{ address: "help@support.acme.com", name: null }],
  cc: [],
  date: "2026-02-01T09:00:00.000Z",
  subject: "Invoice 42",
  text: "See attached.",
  attachments: [{ filename: "invoice.pdf", mimeType: "application/pdf", content: new Uint8Array([1, 2, 3]) }],
  ...overrides,
});

test("sendRuleForward sends once from the inbox, with reply-to and loop marker", async (t) => {
  const f = fixture(t);
  const rule = await createMailRule(f.env, {
    name: "Fwd", conditions: all(c("subject", "contains", "invoice")),
    forward_to: ["accounting@example.com"], forward_cc: ["boss@example.com"], forward_bcc: ["audit@example.com"],
  });
  const forward = { ruleId: rule.id, to: rule.forward_to, cc: rule.forward_cc, bcc: rule.forward_bcc };

  const result = await sendRuleForward(f.env, { forward, mailboxId: 1, messageId: 100, original: original() });
  assert.deepEqual(result, { status: "sent", messageId: "<sent-1@provider>" });
  assert.equal(f.sent.length, 1);
  const mail = f.sent[0];
  assert.deepEqual(mail.from, { email: "help@support.acme.com", name: "Acme Help" });
  assert.deepEqual([mail.to, mail.cc, mail.bcc], [["accounting@example.com"], ["boss@example.com"], ["audit@example.com"]]);
  assert.equal(mail.subject, "Fwd: Invoice 42");
  assert.equal(mail.replyTo, "billing@vendor.com");
  assert.equal(mail.headers["X-Mailroom-Forward"], String(rule.id));
  assert.match(mail.text, /^---------- Forwarded message ---------\nFrom: Vendor Billing <billing@vendor.com>\n/);
  assert.match(mail.text, /\n\nSee attached\.$/);
  assert.equal(mail.attachments.length, 1);

  assert.deepEqual(await sendRuleForward(f.env, { forward, mailboxId: 1, messageId: 100, original: original() }), { status: "duplicate" });
  assert.equal(f.sent.length, 1);

  const [listed] = (await f.call("GET", "")).body;
  assert.equal(listed.forward_count, 1);
  assert.equal(listed.last_forward_error, null);
});

test("sendRuleForward records failures and never forwards into the workspace", async (t) => {
  const f = fixture(t);
  const rule = await createMailRule(f.env, { name: "Fwd", conditions: all(c("subject", "contains", "x")), forward_to: ["ops@example.com"] });
  const forward = { ruleId: rule.id, to: ["ops@example.com"], cc: [], bcc: [] };

  f.env.EMAIL.failWith = "Recipient not allowed";
  const failed = await sendRuleForward(f.env, { forward, mailboxId: 1, messageId: 100, original: original() });
  assert.deepEqual(failed, { status: "failed", error: "Recipient not allowed" });
  assert.equal((await f.call("GET", "")).body[0].last_forward_error, "Recipient not allowed");
  f.env.EMAIL.failWith = null;

  // An address that became an Inbox after the rule was saved is dropped.
  const own = await sendRuleForward(f.env, {
    forward: { ...forward, to: ["Sales@support.acme.com"] }, mailboxId: 1, messageId: 101, original: original(),
  });
  assert.equal(own.status, "failed");
  assert.equal(f.sent.length, 0);

  const saved = await f.call("POST", "", { name: "Loop", conditions: all(c("subject", "contains", "x")), forward_to: ["help@support.acme.com"] });
  assert.equal(saved.status, 400);
  assert.match(saved.body.error, /workspace's inboxes/);

  f.db.exec("UPDATE domains SET status = 'pending'");
  const other = await createMailRule(f.env, { name: "Pending", conditions: all(c("subject", "contains", "x")), forward_to: ["ops@example.com"] });
  const pending = await sendRuleForward(f.env, { forward: { ...forward, ruleId: other.id }, mailboxId: 1, messageId: 100, original: original() });
  assert.deepEqual(pending, { status: "failed", error: "The inbox's domain is not ready for sending" });
});

test("buildForward keeps Fwd subjects, lists recipients and leaves out oversized attachments", () => {
  const big = new Uint8Array(3 * 1024 * 1024);
  const built = buildForward(original({
    subject: "FW: Invoice",
    cc: [{ address: "boss@acme.com", name: "The Boss" }],
    attachments: [
      { filename: "small.txt", mimeType: "text/plain", content: "hi" },
      { filename: "huge.zip", mimeType: "application/zip", content: big },
    ],
  }));
  assert.equal(built.subject, "FW: Invoice");
  assert.match(built.text, /\nCc: The Boss <boss@acme.com>\n/);
  assert.deepEqual(built.attachments.map((a) => a.filename), ["small.txt"]);
  assert.match(built.text, /\[1 attachment was too large to forward: huge\.zip\]$/);
  assert.equal(buildForward(original({ subject: "" })).subject, "Fwd: (no subject)");
});

test("mail rules API creates, lists, validates, updates, and deletes", async (t) => {
  const f = fixture(t);
  const conditions = all(c("from", "domain_is", "vendor.com"));
  const created = await f.call("POST", "", { name: "Invoices", mailbox_id: 1, conditions, label_id: 1, archive: true });
  assert.equal(created.status, 201);
  assert.equal(created.body.label_name, "Invoices");
  assert.equal(created.body.mailbox_address, "help@support.acme.com");
  assert.deepEqual(created.body.conditions, conditions);
  assert.equal(created.body.archive, true);
  assert.equal(created.body.mark_read, false);
  assert.deepEqual(created.body.forward_to, []);

  assert.equal((await f.call("POST", "", { name: "x", mailbox_id: 1, conditions, label_id: 2 })).status, 400);
  assert.equal((await f.call("POST", "", { name: "x", mailbox_id: 99, conditions, archive: true })).status, 400);
  assert.equal((await f.call("POST", "", { name: "x", conditions })).status, 400);

  const updated = await f.call("PUT", `/${created.body.id}`, {
    name: "Invoices", mailbox_id: 1, conditions, label_id: 1, archive: true, enabled: false, forward_to: ["a@example.com"],
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.body.enabled, false);
  assert.deepEqual(updated.body.forward_to, ["a@example.com"]);
  assert.equal((await f.call("PUT", "/999", { name: "x", conditions, archive: true })).status, 404);

  assert.deepEqual((await f.call("GET", "")).body.map((rule) => rule.id), [created.body.id]);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 200);
  assert.equal((await f.call("DELETE", `/${created.body.id}`)).status, 404);
  assert.equal((await f.call("DELETE", "/abc")).status, 400);
});

test("deleting a label, a message or an inbox keeps rules consistent", async (t) => {
  const f = fixture(t);
  const rule = await createMailRule(f.env, {
    name: "Label", mailbox_id: 1, conditions: all(c("subject", "contains", "x")), label_id: 1, forward_to: ["a@example.com"],
  });
  await sendRuleForward(f.env, { forward: { ruleId: rule.id, to: ["a@example.com"], cc: [], bcc: [] }, mailboxId: 1, messageId: 100, original: original() });
  f.db.exec("DELETE FROM thread_labels WHERE label_id = 1; DELETE FROM labels WHERE id = 1");
  assert.equal(f.db.prepare("SELECT label_id FROM mail_rules WHERE id = ?").get(rule.id).label_id, null);
  f.db.exec("DELETE FROM messages WHERE thread_id = 10; DELETE FROM threads WHERE mailbox_id = 1; DELETE FROM mailboxes WHERE id = 1");
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM mail_rules").get().count, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS count FROM mail_rule_forwards").get().count, 0);
});

test("migration 0021 carries the old fixed conditions into the flow format", (t) => {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const files = readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort();
  for (const file of files.filter((file) => file < "0021")) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  db.exec(`INSERT INTO mail_rules (name, from_pattern, subject_contains, body_contains, has_attachment, archive) VALUES
    ('address', 'Billing@Vendor.com', 'Invoice', NULL, 1, 1),
    ('domain', '@vendor.com', NULL, NULL, 0, 1),
    ('wildcard', '*.vendor.com', NULL, 'refund', 0, 1),
    ('name', 'Stripe', NULL, NULL, 0, 1)`);
  for (const file of files.filter((file) => file >= "0021")) db.exec(readFileSync(`migrations/${file}`, "utf8"));
  const rows = Object.fromEntries(db.prepare("SELECT name, conditions FROM mail_rules").all().map((row) => [row.name, JSON.parse(row.conditions)]));
  assert.deepEqual(rows.address, all(c("from", "is", "billing@vendor.com"), c("subject", "contains", "Invoice"), c("has_attachment", "yes")));
  assert.deepEqual(rows.domain, all(c("from", "domain_is", "vendor.com")));
  assert.deepEqual(rows.wildcard, all(c("from", "domain_is", "vendor.com"), c("body", "contains", "refund")));
  assert.deepEqual(rows.name, all(c("from", "contains", "Stripe")));
});
