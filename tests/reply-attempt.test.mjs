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
  displayName = null;
  signature = null;
  messages = [];
  messageBodies = [];

  prepare(sql) {
    return new FakeStatement(this, sql);
  }

  async first(sql, args) {
    if (sql.includes("SELECT * FROM reply_attempts")) return this.attempts.get(args[0]) ?? null;
    if (sql.includes("SELECT t.id, t.mailbox_id, t.subject")) {
      return {
        id: 1,
        mailbox_id: 1,
        subject: "Help",
        mailbox_address: "support@example.com",
        mailbox_display_name: this.displayName,
        mailbox_signature_mode: this.signature?.mode ?? "default",
        mailbox_signature_html: this.signature?.html ?? null,
        default_signature_html: this.signature?.fallback ?? null,
      };
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
        cc_addresses: args[10],
        bcc_addresses: args[11],
        signature_html: args[12],
        html_body: args[13],
        message_id: null,
        error: null,
      });
    } else if (sql.includes("INSERT INTO messages")) {
      this.messages.push({ from_address: args[5], from_name: args[6] });
      this.messageBodies.push({ text_body: args[9], html_body: args[13] });
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

test("a reply is sent under the inbox's sender name", async () => {
  const fixture = makeEnv();
  fixture.env.DB.displayName = "Jane Doe from Acme";

  await sendReplyAttempt(fixture.env, { attemptId: "attempt-named", threadId: 1, text: "Hello" });

  assert.deepEqual(fixture.sent()[0].from, {
    email: "support@example.com",
    name: "Jane Doe from Acme",
  });
  assert.deepEqual(fixture.env.DB.messages[0], {
    from_address: "support@example.com",
    from_name: "Jane Doe from Acme",
  });
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

test("a Reply Attempt sends Cc and Bcc copies and keeps them bound to the attempt", async () => {
  const fixture = makeEnv();
  const intent = {
    attemptId: "attempt-cc",
    threadId: 1,
    text: "Looping in the team",
    cc: ["Team@Example.COM", "customer@example.com", "team@example.com"],
    bcc: ["audit@example.com", "team@example.com"],
  };

  const first = await sendReplyAttempt(fixture.env, intent);
  assert.equal(first.status, "sent");
  const [sent] = fixture.sent();
  assert.deepEqual(sent.to, ["customer@example.com"]);
  assert.deepEqual(sent.cc, ["Team@example.com"]);
  assert.deepEqual(sent.bcc, ["audit@example.com"]);
  const stored = fixture.env.DB.attempts.get("attempt-cc");
  assert.equal(stored.cc_addresses, JSON.stringify(["Team@example.com"]));
  assert.equal(stored.bcc_addresses, JSON.stringify(["audit@example.com"]));

  assert.deepEqual(await sendReplyAttempt(fixture.env, intent), first);
  await assert.rejects(
    sendReplyAttempt(fixture.env, { ...intent, bcc: [] }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a Reply Attempt sends to the To chosen in the composer and keeps it bound to the attempt", async () => {
  const fixture = makeEnv();
  const intent = {
    attemptId: "attempt-to",
    threadId: 1,
    text: "Sending this to the right person",
    to: ["Owner@Example.COM", "owner@example.com", "billing@example.com"],
    cc: ["owner@example.com", "team@example.com"],
  };

  const first = await sendReplyAttempt(fixture.env, intent);
  assert.equal(first.status, "sent");
  const [sent] = fixture.sent();
  assert.deepEqual(sent.to, ["Owner@example.com", "billing@example.com"]);
  assert.deepEqual(sent.cc, ["team@example.com"]);
  assert.equal(
    fixture.env.DB.attempts.get("attempt-to").to_addresses,
    JSON.stringify(["Owner@example.com", "billing@example.com"]),
  );

  assert.deepEqual(await sendReplyAttempt(fixture.env, intent), first);
  await assert.rejects(
    sendReplyAttempt(fixture.env, { ...intent, to: ["customer@example.com"] }),
    (error) => error instanceof ReplyIntentError && error.status === 409,
  );
  assert.equal(fixture.sends(), 1);
});

test("a Reply Attempt with an empty To is rejected before anything is sent", async () => {
  const fixture = makeEnv();
  await assert.rejects(
    sendReplyAttempt(fixture.env, { attemptId: "attempt-empty-to", threadId: 1, text: "Hi", to: [] }),
    (error) => error instanceof ReplyIntentError && error.status === 400,
  );
  assert.equal(fixture.sends(), 0);
});

test("a Reply Attempt without copies omits Cc and Bcc from the provider request", async () => {
  const fixture = makeEnv();
  await sendReplyAttempt(fixture.env, { attemptId: "attempt-no-cc", threadId: 1, text: "Hi" });
  assert.equal("cc" in fixture.sent()[0], false);
  assert.equal("bcc" in fixture.sent()[0], false);
});

test("a Reply Attempt rejects too many combined recipients before sending", async () => {
  const fixture = makeEnv();
  await assert.rejects(
    sendReplyAttempt(fixture.env, {
      attemptId: "attempt-many",
      threadId: 1,
      text: "Hi",
      cc: Array.from({ length: 50 }, (_, index) => `person${index}@example.com`),
    }),
    (error) => error instanceof ReplyIntentError && error.status === 400,
  );
  assert.equal(fixture.sends(), 0);
});

test("a reply appends the inbox signature and sends rich text", async () => {
  const fixture = makeEnv();
  fixture.env.DB.signature = { mode: "custom", html: "<b>Jane</b>", fallback: null };

  await sendReplyAttempt(fixture.env, {
    attemptId: "attempt-signed",
    threadId: 1,
    text: "ignored",
    html: "<p><i>Thanks</i> for writing</p>",
  });

  const sent = fixture.sent()[0];
  assert.equal(sent.text, "Thanks for writing\n\n-- \nJane");
  assert.match(sent.html, /<p><i>Thanks<\/i> for writing<\/p>.*<b>Jane<\/b>/);
  const attempt = fixture.env.DB.attempts.get("attempt-signed");
  assert.equal(attempt.signature_html, "<b>Jane</b>");
  assert.equal(attempt.html_body, "<p><i>Thanks</i> for writing</p>");
  assert.deepEqual(fixture.env.DB.messageBodies[0], { text_body: sent.text, html_body: sent.html });
});
