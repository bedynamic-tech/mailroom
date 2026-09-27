import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailNotification,
  normalizeNotificationAddress,
  notifyNewEmailByEmail,
} from "../src/worker/notifications/email.ts";

const input = {
  threadId: 42,
  inboxAddress: "support@example.com",
  senderName: "  Alice   Customer ",
  senderAddress: "alice@customer.test",
  subject: "  Refund   request ",
  preview: "Hi there,\n\nI would like a refund.",
};

test("normalizes plain notification addresses and rejects anything else", () => {
  assert.equal(normalizeNotificationAddress("  Me@Example.COM "), "me@example.com");
  assert.equal(normalizeNotificationAddress(""), null);
  assert.equal(normalizeNotificationAddress("not-an-address"), null);
  assert.equal(normalizeNotificationAddress("a@b.com, c@d.com"), null);
  assert.equal(normalizeNotificationAddress("Name <a@b.com>"), null);
  assert.equal(normalizeNotificationAddress(42), null);
  assert.equal(normalizeNotificationAddress(`${"a".repeat(250)}@b.com`), null);
});

test("builds a notice that names the sender and links the conversation", () => {
  const content = buildEmailNotification(input, "https://mail.example.com/");
  assert.equal(content.subject, "New email from Alice Customer: Refund request");
  assert.match(content.text, /^support@example\.com received a new email\./);
  assert.match(content.text, /From: Alice Customer <alice@customer\.test>/);
  assert.match(content.text, /I would like a refund\./);
  assert.match(content.text, /Open conversation: https:\/\/mail\.example\.com\/inbox\/42/);
});

test("omits the link when no origin is known and falls back on empty fields", () => {
  const content = buildEmailNotification(
    { ...input, senderName: null, senderAddress: "", subject: "", preview: "" },
    null,
  );
  assert.equal(content.subject, "New email from Unknown sender: (no subject)");
  assert.doesNotMatch(content.text, /Open conversation/);
});

function fakeEnv({ address, inboxes = [] }) {
  const sent = [];
  return {
    sent,
    EMAIL: {
      async send(message) {
        sent.push(message);
        return { messageId: "id@example.com" };
      },
    },
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            this.args = args;
            return this;
          },
          async first() {
            if (sql.includes("global_settings")) {
              return { email_notification_address: address, email_notification_origin: "https://mail.example.com" };
            }
            return this.args.some((value) => inboxes.includes(value)) ? { id: 1 } : null;
          },
        };
      },
    },
  };
}

test("sends from the receiving inbox as auto-generated mail", async () => {
  const env = fakeEnv({ address: "me@example.org" });
  await notifyNewEmailByEmail(env, input);
  assert.equal(env.sent.length, 1);
  assert.deepEqual(env.sent[0].to, ["me@example.org"]);
  assert.deepEqual(env.sent[0].from, { email: "support@example.com", name: "Mailroom" });
  assert.equal(env.sent[0].headers["Auto-Submitted"], "auto-generated");
});

test("does nothing when email notifications are off", async () => {
  const env = fakeEnv({ address: null });
  await notifyNewEmailByEmail(env, input);
  assert.equal(env.sent.length, 0);
});

test("never notifies about mail that could loop", async () => {
  const fromRecipient = fakeEnv({ address: "alice@customer.test" });
  await notifyNewEmailByEmail(fromRecipient, input);
  assert.equal(fromRecipient.sent.length, 0);

  const fromInbox = fakeEnv({ address: "me@example.org", inboxes: ["alice@customer.test"] });
  await notifyNewEmailByEmail(fromInbox, input);
  assert.equal(fromInbox.sent.length, 0);

  const toInbox = fakeEnv({ address: "me@example.org", inboxes: ["me@example.org"] });
  await notifyNewEmailByEmail(toInbox, input);
  assert.equal(toInbox.sent.length, 0);
});
