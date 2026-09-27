import test from "node:test";
import assert from "node:assert/strict";
import {
  ComposeIntentError,
  sendNewEmailAttempt,
} from "../src/worker/email/compose.ts";

class FakeStatement {
  constructor(db, sql, args = []) {
    this.db = db;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new FakeStatement(this.db, this.sql, args);
  }

  first() {
    return this.db.first(this.sql, this.args);
  }

  run() {
    return this.db.run(this.sql, this.args);
  }
}

class FakeDb {
  attempts = new Map();
  threads = new Map();
  messages = [];
  messageAttachments = [];
  nextThread = 1;

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async first(sql, args) {
    if (sql.includes("SELECT * FROM outbound_attempts")) {
      return this.attempts.get(args[0]) ?? null;
    }
    if (sql.includes("SELECT m.id, m.address")) {
      return args[0] === 1
        ? { id: 1, address: "support@example.com", domain_status: "active" }
        : null;
    }
    if (sql.includes("UPDATE outbound_attempts") && sql.includes("RETURNING id")) {
      const attempt = this.attempts.get(args[0]);
      if (!attempt || attempt.status !== "pending") return null;
      attempt.status = "sending";
      return { id: attempt.id };
    }
    if (sql.includes("INSERT INTO threads")) {
      const id = this.nextThread++;
      this.threads.set(id, { id, message_count: 0 });
      return { id };
    }
    return null;
  }

  async run(sql, args) {
    if (sql.includes("INSERT INTO outbound_attempts")) {
      if (this.attempts.has(args[0])) throw new Error("UNIQUE constraint failed");
      this.attempts.set(args[0], {
        id: args[0],
        mailbox_id: args[1],
        thread_id: null,
        status: "pending",
        to_addresses: args[2],
        subject: args[3],
        text_body: args[4],
        attachments: args[5],
        actor_id: args[6],
        oauth_client_id: args[7],
        sent_by: args[8],
        message_id: null,
        error: null,
      });
    } else if (sql.includes("INSERT INTO attachments")) {
      this.messageAttachments.push({
        filename: args[0],
        content_type: args[1],
        r2_key: args[5],
        rfc_message_id: args[6],
      });
    } else if (sql.includes("SET thread_id = ?") && !sql.includes("status = 'failed'")) {
      this.attempts.get(args[2]).thread_id = args[0];
    } else if (sql.includes("INSERT INTO threads")) {
      this.threads.set(args[0], { id: args[0], message_count: 0 });
    } else if (sql.includes("INSERT INTO messages")) {
      this.messages.push({ thread_id: args[0], message_id: args[1], sent_by: args[2], to: args[4] });
    } else if (sql.includes("UPDATE threads") && sql.includes("message_count = 1")) {
      this.threads.get(args[2]).message_count = 1;
    } else if (sql.includes("SET status = 'sent'")) {
      const attempt = this.attempts.get(args[2]);
      attempt.status = "sent";
      attempt.message_id = args[0];
      attempt.error = null;
    }
    return { success: true, meta: { changes: 1, last_row_id: 1 } };
  }

  async batch(statements) {
    return Promise.all(statements.map((statement) => statement.run()));
  }
}

function makeFixture() {
  const db = new FakeDb();
  const sent = [];
  const objects = new Map();
  return {
    db,
    objects,
    env: {
      DB: db,
      RAW: {
        async put(key, value) {
          objects.set(key, value);
        },
      },
      EMAIL: {
        async send(message) {
          sent.push(message);
          return { messageId: "outbound@example.com" };
        },
      },
    },
    sends: () => sent.length,
    sent: () => sent,
  };
}

const intent = {
  attemptId: "mcp_send_stable-key",
  mailboxId: 1,
  to: ["Customer@Example.com"],
  subject: "Hello",
  text: "A durable message",
  actorId: "owner@example.com",
  oauthClientId: "test-client",
};

test("a new-email Send Attempt is recorded in the inbox and sent once", async () => {
  const fixture = makeFixture();

  const first = await sendNewEmailAttempt(fixture.env, intent);
  const replay = await sendNewEmailAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(fixture.db.messages.length, 1);
  assert.equal(fixture.db.messages[0].sent_by, "agent");
  assert.equal(fixture.sent()[0].headers["Auto-Submitted"], "auto-generated");
  assert.equal(fixture.db.threads.get(first.conversation_id).message_count, 1);
});

test("a new-email idempotency key cannot be reused for different content", async () => {
  const fixture = makeFixture();
  await sendNewEmailAttempt(fixture.env, intent);

  await assert.rejects(
    sendNewEmailAttempt(fixture.env, { ...intent, subject: "Different" }),
    (error) => error instanceof ComposeIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a provider-accepted Send Attempt finalizes without sending again", async () => {
  const fixture = makeFixture();
  fixture.db.threads.set(42, { id: 42, message_count: 0 });
  fixture.db.attempts.set("mcp_send_recover", {
    id: "mcp_send_recover",
    mailbox_id: 1,
    thread_id: 42,
    status: "sending",
    to_addresses: JSON.stringify(["Customer@example.com"]),
    subject: "Recover",
    text_body: "Already accepted",
    actor_id: "owner@example.com",
    oauth_client_id: null,
    message_id: "accepted@example.com",
    error: null,
  });

  const result = await sendNewEmailAttempt(fixture.env, {
    attemptId: "mcp_send_recover",
    mailboxId: 1,
    to: ["Customer@Example.com"],
    subject: "Recover",
    text: "Already accepted",
    actorId: "owner@example.com",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 0);
  assert.equal(fixture.db.messages.length, 1);
});

test("a new email with attachments is staged, sent, and recorded", async () => {
  const fixture = makeFixture();
  const withAttachment = {
    ...intent,
    attemptId: "mcp_send_attach",
    attachments: [
      { filename: "invoice.pdf", contentType: "application/pdf", content: new Uint8Array([37, 80]) },
    ],
  };

  const first = await sendNewEmailAttempt(fixture.env, withAttachment);
  const replay = await sendNewEmailAttempt(fixture.env, withAttachment);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(fixture.sent()[0].attachments[0].filename, "invoice.pdf");
  assert.equal(fixture.db.messageAttachments.length, 1);
  assert.ok(
    [...fixture.objects.keys()][0].startsWith("attachments/1/outbound/mcp_send_attach/"),
  );
});

test("a Send Attempt id cannot be reused with different attachments", async () => {
  const fixture = makeFixture();
  await sendNewEmailAttempt(fixture.env, {
    ...intent,
    attemptId: "mcp_send_att_conflict",
    attachments: [{ filename: "a.txt", contentType: "text/plain", content: "a" }],
  });

  await assert.rejects(
    sendNewEmailAttempt(fixture.env, {
      ...intent,
      attemptId: "mcp_send_att_conflict",
      attachments: [{ filename: "b.txt", contentType: "text/plain", content: "b" }],
    }),
    (error) => error instanceof ComposeIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});
