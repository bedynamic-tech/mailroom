import test from "node:test";
import assert from "node:assert/strict";
import { ReplyIntentError, sendReplyAttempt } from "../src/worker/email/reply.ts";

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
  messageAttachments = [];
  allowBudget = true;

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async first(sql, args) {
    if (sql.includes("SELECT * FROM reply_attempts")) return this.attempts.get(args[0]) ?? null;
    if (sql.includes("SELECT t.id, t.mailbox_id, t.subject")) {
      return { id: 1, mailbox_id: 1, subject: "Help", mailbox_address: "support@example.com" };
    }
    if (sql.includes("SELECT id, message_id, from_address")) {
      const requestedMessageId = args[1];
      if (requestedMessageId && requestedMessageId !== 9) return null;
      return {
        id: 9,
        message_id: "<inbound@example.com>",
        from_address: "form@example.com",
        reply_to_addresses: JSON.stringify(["customer@example.com"]),
        references_ids: "[]",
      };
    }
    if (sql.includes("UPDATE reply_attempts") && sql.includes("RETURNING id")) {
      const attempt = this.attempts.get(args[0]);
      if (!attempt || attempt.status !== "pending") return null;
      attempt.status = "sending";
      return { id: attempt.id };
    }
    if (sql.includes("INSERT INTO mcp_send_budget")) {
      return this.allowBudget ? { send_count: 1 } : null;
    }
    return null;
  }

  async run(sql, args) {
    if (sql.includes("INSERT INTO reply_attempts")) {
      if (this.attempts.has(args[0])) throw new Error("UNIQUE constraint failed");
      this.attempts.set(args[0], {
        id: args[0],
        thread_id: args[1],
        inbound_message_id: args[2],
        draft_id: args[3],
        status: "pending",
        text_body: args[4],
        to_addresses: args[5],
        attachments: args[6],
        sent_by: args[7],
        actor_id: args[8],
        oauth_client_id: args[9],
        message_id: null,
        error: null,
      });
    } else if (sql.includes("INSERT INTO attachments")) {
      this.messageAttachments.push({
        filename: args[0],
        content_type: args[1],
        size: args[2],
        disposition: args[3],
        content_id: args[4],
        r2_key: args[5],
        rfc_message_id: args[6],
      });
    } else if (sql.includes("SET status = 'failed'")) {
      const attemptId = args.length === 1 ? args[0] : args[1];
      const attempt = this.attempts.get(attemptId);
      attempt.status = "failed";
      attempt.error = args.length === 1 ? "Daily MCP send limit reached" : args[0];
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

function makeEnv({ fail = false } = {}) {
  const db = new FakeDb();
  const sent = [];
  const objects = new Map();
  return {
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
          if (fail) throw new Error("provider unavailable");
          return { messageId: "outbound@example.com" };
        },
      },
    },
    sends: () => sent.length,
    sent: () => sent,
    objects,
  };
}

test("replaying one Reply Attempt returns the stored result without sending twice", async () => {
  const fixture = makeEnv();
  const intent = { attemptId: "attempt-1", threadId: 1, text: "Hello" };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
});

test("a failed Reply Attempt is not automatically sent again", async () => {
  const fixture = makeEnv({ fail: true });
  const intent = { attemptId: "attempt-2", threadId: 1, text: "Hello" };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "failed");
  assert.equal(replay.status, "failed");
  assert.equal(fixture.sends(), 1);
});

test("a Reply Attempt id cannot be reused for different content", async () => {
  const fixture = makeEnv();
  await sendReplyAttempt(fixture.env, { attemptId: "attempt-3", threadId: 1, text: "First" });

  await assert.rejects(
    sendReplyAttempt(fixture.env, { attemptId: "attempt-3", threadId: 1, text: "Changed" }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a pending Reply Attempt resumes safely after an interrupted request", async () => {
  const fixture = makeEnv();
  fixture.env.DB.attempts.set("attempt-4", {
    id: "attempt-4",
    thread_id: 1,
    inbound_message_id: 9,
    draft_id: null,
    status: "pending",
    text_body: "Resume me",
    to_addresses: JSON.stringify(["customer@example.com"]),
    message_id: null,
    error: null,
  });

  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-4",
    threadId: 1,
    text: "Resume me",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 1);
});

test("a provider-accepted Reply Attempt finalizes without sending again", async () => {
  const fixture = makeEnv();
  fixture.env.DB.attempts.set("attempt-5", {
    id: "attempt-5",
    thread_id: 1,
    inbound_message_id: 9,
    draft_id: null,
    status: "sending",
    text_body: "Already accepted",
    to_addresses: JSON.stringify(["customer@example.com"]),
    message_id: "outbound@example.com",
    error: null,
    sent_by: "human",
    actor_id: null,
    oauth_client_id: null,
  });

  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-5",
    threadId: 1,
    text: "Already accepted",
  });

  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 0);
});

test("replying to a stale inbound Message requires rereading the Conversation", async () => {
  const fixture = makeEnv();

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-6",
      threadId: 1,
      inboundMessageId: 8,
      expectedRecipients: ["customer@example.com"],
      text: "Stale reply",
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 0);
});

test("reply recipients must match the target that the caller reviewed", async () => {
  const fixture = makeEnv();

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-7",
      threadId: 1,
      inboundMessageId: 9,
      expectedRecipients: ["victim@example.com"],
      text: "Wrong target",
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 0);
});

test("the daily send budget blocks an agent before provider delivery", async () => {
  const fixture = makeEnv();
  fixture.env.DB.allowBudget = false;

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-8",
      threadId: 1,
      inboundMessageId: 9,
      expectedRecipients: ["customer@example.com"],
      text: "Over budget",
      actorId: "owner-subject",
      dailySendLimit: 100,
    }),
    (error) => error instanceof ReplyIntentError && error.status === 429,
  );
  assert.equal(fixture.sends(), 0);
});

test("a reply with attachments is staged in R2, sent, and recorded once", async () => {
  const fixture = makeEnv();
  const intent = {
    attemptId: "attempt-att",
    threadId: 1,
    text: "See attached",
    attachments: [
      { filename: "log.txt", contentType: "text/plain", content: "hello" },
    ],
  };

  const first = await sendReplyAttempt(fixture.env, intent);
  const replay = await sendReplyAttempt(fixture.env, intent);

  assert.equal(first.status, "sent");
  assert.deepEqual(replay, first);
  assert.equal(fixture.sends(), 1);
  assert.equal(fixture.sent()[0].attachments.length, 1);
  assert.equal(fixture.sent()[0].attachments[0].filename, "log.txt");
  assert.equal(fixture.sent()[0].attachments[0].type, "text/plain");
  assert.equal(fixture.env.DB.messageAttachments.length, 1);
  assert.equal(fixture.env.DB.messageAttachments[0].filename, "log.txt");
  const [r2Key] = [...fixture.objects.keys()];
  assert.ok(r2Key.startsWith("attachments/1/outbound/attempt-att/"));
  assert.equal(fixture.env.DB.messageAttachments[0].r2_key, r2Key);
});

test("an attachment-only reply sends without text", async () => {
  const fixture = makeEnv();
  const result = await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-file-only",
    threadId: 1,
    text: "",
    attachments: [
      { filename: "doc.pdf", contentType: "application/pdf", content: new Uint8Array([1, 2]) },
    ],
  });
  assert.equal(result.status, "sent");
  assert.equal(fixture.sends(), 1);
});

test("an attempt id cannot be reused with different attachments", async () => {
  const fixture = makeEnv();
  await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-att-2",
    threadId: 1,
    text: "Here",
    attachments: [{ filename: "a.txt", contentType: "text/plain", content: "a" }],
  });

  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-att-2",
      threadId: 1,
      text: "Here",
      attachments: [{ filename: "b.txt", contentType: "text/plain", content: "b" }],
    }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});
