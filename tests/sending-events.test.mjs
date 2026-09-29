import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { isEmailSendingEvent, recordSendingEvent } from "../src/worker/email/sending-events.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'acme.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'help@acme.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, normalized_subject, message_count, last_message_at)
      VALUES (10, 1, 'Order question', 'order question', 1, '2026-09-29T10:00:00.000Z');`);
  db.prepare(`INSERT INTO messages (id, thread_id, message_id, direction, sent_by, from_address,
      to_addresses, cc_addresses, bcc_addresses, subject, created_at)
    VALUES (101, 10, '<0101018f7d0c4d9a-msg-bounced>', 'outbound', 'human', 'help@acme.com',
      ?, ?, '[]', 'Re: Order question', strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 hour'))`)
    .run(JSON.stringify(["jane@customer.org"]), JSON.stringify(["Nobody@Gmail.com"]));
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: Number(result.changes) } }; },
    };
  }
  return { db, env: { DB: { prepare: statement } } };
}

// Shaped like Cloudflare's documented message.bounced event.
function bounced(overrides = {}) {
  return {
    type: "cf.email.sending.message.bounced",
    source: { type: "email.sending", zoneId: "z", domain: "acme.com" },
    payload: {
      eventId: "e1",
      messageId: "0101018f7d0c4d9a-msg-bounced",
      sender: "help@acme.com",
      recipient: "nobody@gmail.com",
      subject: "Re: Order question",
      terminal: true,
      delivery: {
        status: "bounced",
        smtpStatusCode: "550",
        smtpEnhancedStatusCode: "5.1.1",
        smtpResponse: "550 5.1.1 User unknown",
      },
      bounce: { type: "hard", classification: "permanent_failure", reason: "550 5.1.1 User unknown" },
      ...overrides,
    },
    metadata: { accountId: "a", eventSubscriptionId: "s", eventSchemaVersion: 1, eventTimestamp: "2026-09-29T15:00:00Z" },
  };
}

const rows = (db) => db.prepare("SELECT message_id, recipient, status, diagnostic FROM message_bounces").all().map((row) => ({ ...row }));

test("only Email Sending events are told apart from draft jobs", () => {
  assert.equal(isEmailSendingEvent(bounced()), true);
  assert.equal(isEmailSendingEvent({ runId: 4 }), false);
  assert.equal(isEmailSendingEvent(null), false);
});

test("a bounced Cc is recorded on the sent message by its Message-ID", async (t) => {
  const { db, env } = fixture(t);
  assert.equal(await recordSendingEvent(env, bounced()), true);
  assert.deepEqual(rows(db), [{ message_id: 101, recipient: "nobody@gmail.com", status: "5.1.1", diagnostic: "550 5.1.1 User unknown" }]);

  // A repeated event keeps the one record.
  await recordSendingEvent(env, bounced());
  assert.equal(rows(db).length, 1);
});

test("without a matching Message-ID the latest email from that sender to that recipient is used", async (t) => {
  const { db, env } = fixture(t);
  assert.equal(await recordSendingEvent(env, bounced({ messageId: "other-id", sender: "Help <HELP@acme.com>" })), true);
  assert.deepEqual(rows(db).map((row) => row.message_id), [101]);
});

test("a rejected recipient is recorded with Cloudflare's reason", async (t) => {
  const { db, env } = fixture(t);
  await recordSendingEvent(env, {
    type: "cf.email.sending.message.rejected",
    payload: {
      messageId: "0101018f7d0c4d9a-msg-bounced",
      recipient: "nobody@gmail.com",
      terminal: true,
      delivery: { status: "rejected" },
      rejection: { reason: "suppressed", party: "recipient", detail: "Recipient is suppressed" },
    },
  });
  assert.deepEqual(rows(db), [{ message_id: 101, recipient: "nobody@gmail.com", status: null, diagnostic: "Recipient is suppressed" }]);
});

test("delivered, deferred and unknown mail records nothing", async (t) => {
  const { db, env } = fixture(t);
  assert.equal(await recordSendingEvent(env, { ...bounced(), type: "cf.email.sending.message.delivered" }), false);
  assert.equal(await recordSendingEvent(env, { ...bounced(), type: "cf.email.sending.message.deferred" }), false);
  assert.equal(await recordSendingEvent(env, bounced({ terminal: false })), false);
  assert.equal(await recordSendingEvent(env, bounced({ messageId: "x", sender: "news@acme.com" })), false);
  assert.equal(rows(db).length, 0);
});
