import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import PostalMime from "postal-mime";
import { matchBounce, parseBounce, parseDeliveryStatus, recordBounces } from "../src/worker/email/bounce.ts";
import { deleteArchivedConversations } from "../src/worker/inbox/delete-conversations.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@acme.com', 1), (2, 'sales@acme.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, normalized_subject, message_count, last_message_at)
      VALUES (10, 1, 'Order question', 'order question', 2, '2026-09-29T10:00:00.000Z');
    INSERT INTO messages (id, thread_id, message_id, direction, from_address, subject, created_at)
      VALUES (100, 10, '<question@customer.org>', 'inbound', 'jane@customer.org', 'Order question', '2026-09-29T09:00:00.000Z');`);
  db.prepare(`INSERT INTO messages (id, thread_id, message_id, in_reply_to, direction, sent_by, from_address,
      to_addresses, cc_addresses, bcc_addresses, subject, text_body, created_at)
    VALUES (101, 10, '<sent-1@acme.com>', '<question@customer.org>', 'outbound', 'human', 'help@acme.com',
      ?, ?, '[]', 'Re: Order question', 'Your order ships today.', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'))`)
    .run(JSON.stringify(["jane@customer.org"]), JSON.stringify(["Nobody@Gmail.com"]));
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
    RAW: { async put() {} },
  };
  return { db, env };
}

// What receiveEmail does with a notice: match it, store it as mail, then
// record the failed recipients against the sent Message.
async function receive(env, db, raw, mailboxId = 1) {
  const parsed = await PostalMime.parse(raw);
  const report = parseBounce(parsed);
  const match = report ? await matchBounce(env, mailboxId, report) : null;
  const threadId = Number(db.prepare(`INSERT INTO threads (mailbox_id, subject, last_message_at)
      VALUES (?, ?, '2026-09-29T11:00:00.000Z')`).run(mailboxId, parsed.subject).lastInsertRowid);
  const existing = db.prepare("SELECT id FROM messages WHERE message_id = ?").get(parsed.messageId);
  if (existing) return;
  const stored = Number(db.prepare(`INSERT INTO messages (thread_id, message_id, direction, from_address, subject)
    VALUES (?, ?, 'inbound', ?, ?)`).run(threadId, parsed.messageId, parsed.from.address, parsed.subject).lastInsertRowid);
  if (match) await recordBounces(env, match, stored);
}

// A Gmail-style notice: the Cc bounced, the To was delivered.
const dsn = (returnedId = "<sent-1@acme.com>") => `From: Mail Delivery Subsystem <mailer-daemon@googlemail.com>
To: help@acme.com
Subject: Delivery Status Notification (Failure)
Message-ID: <bounce-${Math.random()}@mx.google.com>
Auto-Submitted: auto-replied
MIME-Version: 1.0
Content-Type: multipart/report; report-type=delivery-status; boundary="b1"

--b1
Content-Type: text/plain; charset=UTF-8

Address not found

Your message wasn't delivered to nobody@gmail.com because the address couldn't be found.

--b1
Content-Type: message/delivery-status

Reporting-MTA: dns; googlemail.com

Final-Recipient: rfc822; nobody@gmail.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550-5.1.1 The email account that you tried to reach does
 not exist.

Final-Recipient: rfc822; jane@customer.org
Action: delivered
Status: 2.0.0

--b1
Content-Type: text/rfc822-headers

From: help@acme.com
To: jane@customer.org
Cc: Nobody@Gmail.com
Subject: Re: Order question
Message-ID: ${returnedId}

--b1--
`;

test("a delivery status notice lists only the recipients that failed", () => {
  const failed = parseDeliveryStatus(`Reporting-MTA: dns; mx.example

Original-Recipient: rfc822;Sales@Example.com
Final-Recipient: rfc822; <sales@example.com>
Action: failed
Status: 5.2.2 (mailbox full)
Diagnostic-Code: smtp;552 5.2.2 Mailbox full

Final-Recipient: rfc822; ok@example.com
Action: delayed
Status: 4.4.1

Final-Recipient: rfc822; noaction@example.com
Status: 5.0.0
`);
  assert.deepEqual(failed, [
    { address: "sales@example.com", status: "5.2.2", diagnostic: "552 5.2.2 Mailbox full" },
    { address: "noaction@example.com", status: "5.0.0", diagnostic: "" },
  ]);
});

test("a DSN is read with its returned Message-ID; ordinary mail is not a bounce", async () => {
  const report = parseBounce(await PostalMime.parse(dsn()));
  assert.equal(report.kind, "dsn");
  assert.deepEqual(report.failed.map((item) => item.address), ["nobody@gmail.com"]);
  assert.match(report.failed[0].diagnostic, /^550-5\.1\.1 The email account that you tried to reach does not exist\.$/);
  assert.ok(report.originalMessageIds.includes("<sent-1@acme.com>"));

  const customer = await PostalMime.parse(`From: jane@customer.org
To: help@acme.com
Subject: Delivery failed for my parcel

Where is my order?`);
  assert.equal(parseBounce(customer), null);
});

test("a bounced Cc marks only that recipient of the sent email", async (t) => {
  const { db, env } = fixture(t);
  await receive(env, db, dsn());

  const bounces = db.prepare("SELECT message_id, recipient, status, diagnostic, bounce_message_id FROM message_bounces").all();
  assert.equal(bounces.length, 1);
  assert.equal(bounces[0].message_id, 101);
  assert.equal(bounces[0].recipient, "nobody@gmail.com");
  assert.equal(bounces[0].status, "5.1.1");
  assert.match(bounces[0].diagnostic, /does not exist/);

  const notice = db.prepare("SELECT subject FROM messages WHERE id = ?").get(bounces[0].bounce_message_id);
  assert.equal(notice.subject, "Delivery Status Notification (Failure)");

  // A second notice for the same recipient keeps the one record.
  await receive(env, db, dsn());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_bounces").get().n, 1);
});

test("a notice without a usable Message-ID matches the latest email to that address", async (t) => {
  const { db, env } = fixture(t);
  await receive(env, db, dsn("<unknown@elsewhere>"));
  assert.deepEqual(
    db.prepare("SELECT message_id, recipient FROM message_bounces").all().map((row) => ({ ...row })),
    [{ message_id: 101, recipient: "nobody@gmail.com" }],
  );
});

test("a notice arriving at another inbox never marks this inbox's email", async (t) => {
  const { db, env } = fixture(t);
  await receive(env, db, dsn(), 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_bounces").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM threads WHERE mailbox_id = 2").get().n, 1);
});

test("a plain-text notice from MAILER-DAEMON marks the recipients it names", async (t) => {
  const { db, env } = fixture(t);
  await receive(env, db, `From: MAILER-DAEMON@mx.customer.org
To: help@acme.com
Subject: failure notice
Message-ID: <qmail-1@mx.customer.org>

Hi. This is the qmail-send program at mx.customer.org.
I'm afraid I wasn't able to deliver your message to the following addresses.

<nobody@gmail.com>:
550 5.1.1 No such user

--- Below this line is a copy of the message.

From: help@acme.com
To: jane@customer.org
Cc: nobody@gmail.com
Message-ID: <sent-1@acme.com>
`);
  const rows = db.prepare("SELECT message_id, recipient, status FROM message_bounces").all().map((row) => ({ ...row }));
  assert.deepEqual(rows, [{ message_id: 101, recipient: "nobody@gmail.com", status: "5.1.1" }]);
});

test("deleting the conversation deletes its bounces", async (t) => {
  const { db, env } = fixture(t);
  await receive(env, db, dsn());
  db.exec("UPDATE threads SET status = 'archived'");
  env.RAW.list = async () => ({ objects: [], truncated: false });
  env.RAW.delete = async () => {};
  // Deleting either the sent email's conversation or the notice's removes the record.
  const notice = db.prepare("SELECT thread_id FROM messages WHERE id = (SELECT bounce_message_id FROM message_bounces)").get();
  await deleteArchivedConversations(env, { ids: [notice.thread_id] });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_bounces").get().n, 0);
  await receive(env, db, dsn());
  db.exec("UPDATE threads SET status = 'archived'");
  await deleteArchivedConversations(env, { ids: [10] });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM message_bounces").get().n, 0);
});
