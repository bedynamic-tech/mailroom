import assert from "node:assert/strict";
import test from "node:test";
import {
  buildEmailNotification,
  normalizeNotificationAddress,
  notifyNewEmailByEmail,
  sendTestEmailNotification,
  validateTemplate,
} from "../src/worker/notifications/email.ts";
import {
  renderNotification,
  unknownPlaceholders,
} from "../src/shared/notification-template.ts";

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

const values = {
  sender_name: "Alice",
  sender_email: "alice@customer.test",
  subject: "Refund",
  preview: "Please help",
  inbox: "support@example.com",
  link: "",
};

test("renders placeholders, tolerates spacing, and keeps unknown ones visible", () => {
  const rendered = renderNotification(
    { fromName: "{{ inbox }} bot", subject: "[{{inbox}}]\n{{subject}}", body: "Hi {{sender_name}} {{nope}}" },
    values,
  );
  assert.equal(rendered.fromName, "support@example.com bot");
  assert.equal(rendered.subject, "[support@example.com] Refund");
  assert.equal(rendered.body, "Hi Alice {{nope}}");
});

test("drops body lines whose placeholders are all empty", () => {
  const rendered = renderNotification(
    { fromName: "", subject: "x", body: "Top\n\nLink: {{link}}\n\nFrom {{sender_name}} {{link}}\nEnd" },
    values,
  );
  assert.equal(rendered.body, "Top\n\nFrom Alice \nEnd");
});

test("lists unknown placeholders once each", () => {
  assert.deepEqual(unknownPlaceholders("{{subject}} {{foo}} {{ foo }} {{bar}}"), ["foo", "bar"]);
});

test("validates templates before saving", () => {
  const ok = { fromName: "Mailroom", subject: "{{subject}}", body: "{{preview}}" };
  assert.equal(validateTemplate(ok), null);
  assert.match(validateTemplate({ ...ok, subject: "  " }), /Subject can't be empty/);
  assert.match(validateTemplate({ ...ok, body: "" }), /Body can't be empty/);
  assert.match(validateTemplate({ ...ok, fromName: "Bad <name>" }), /Sender name/);
  assert.match(validateTemplate({ ...ok, body: "{{sendr_name}}" }), /Unknown placeholder: \{\{sendr_name\}\}/);
  assert.match(validateTemplate({ ...ok, body: 5 }), /required/);
  assert.match(validateTemplate({ ...ok, body: "x".repeat(5001) }), /5000 characters/);
});

test("applies a custom template", () => {
  const content = buildEmailNotification(input, null, {
    fromName: "Alerts",
    subject: "[{{inbox}}] {{subject}}",
    body: "{{sender_email}} wrote:\n{{preview}}",
  });
  assert.equal(content.fromName, "Alerts");
  assert.equal(content.subject, "[support@example.com] Refund request");
  assert.equal(content.text, "alice@customer.test wrote:\nHi there, I would like a refund.");
});

function fakeEnv({
  address,
  enabled = true,
  inboxes = [],
  template = {},
  fromMailbox = null,
  sendError = null,
}) {
  const sent = [];
  return {
    sent,
    EMAIL: {
      async send(message) {
        if (sendError) throw new Error(sendError);
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
              return {
                email_notifications_enabled: enabled ? 1 : 0,
                email_notification_address: address,
                email_notification_origin: "https://mail.example.com",
                email_notification_from_name: null,
                email_notification_from_mailbox_id: fromMailbox?.id ?? null,
                email_notification_subject: null,
                email_notification_body: null,
                ...template,
              };
            }
            if (sql.includes("ORDER BY address")) return { address: "support@example.com" };
            if (sql.includes("WHERE id = ?")) {
              return fromMailbox && this.args[0] === fromMailbox.id && !fromMailbox.deleted
                ? { address: fromMailbox.address }
                : null;
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

test("sends with the saved sender name, inbox, subject and body", async () => {
  const env = fakeEnv({
    address: "me@example.org",
    fromMailbox: { id: 9, address: "alerts@example.com" },
    template: {
      email_notification_from_name: "Support Alerts",
      email_notification_subject: "{{subject}}",
      email_notification_body: "{{link}}",
    },
  });
  await notifyNewEmailByEmail(env, input);
  assert.deepEqual(env.sent[0].from, { email: "alerts@example.com", name: "Support Alerts" });
  assert.equal(env.sent[0].subject, "Refund request");
  assert.equal(env.sent[0].text, "https://mail.example.com/inbox/42");
});

test("falls back to the receiving inbox when the chosen inbox was deleted, and omits an empty name", async () => {
  const env = fakeEnv({
    address: "me@example.org",
    fromMailbox: { id: 9, address: "alerts@example.com", deleted: true },
    template: { email_notification_from_name: "" },
  });
  await notifyNewEmailByEmail(env, input);
  assert.equal(env.sent[0].from, "support@example.com");
});

test("reports why a notice was skipped", async () => {
  assert.deepEqual(await notifyNewEmailByEmail(fakeEnv({ address: null }), input), {
    status: "skipped",
    reason: "off",
  });
  assert.deepEqual(
    await notifyNewEmailByEmail(fakeEnv({ address: "alice@customer.test" }), input),
    { status: "skipped", reason: "from_recipient" },
  );
  assert.deepEqual(
    await notifyNewEmailByEmail(fakeEnv({ address: "me@example.org" }), input),
    { status: "sent", from: "support@example.com", to: "me@example.org" },
  );
});

test("sends a test notice without a conversation link", async () => {
  const env = fakeEnv({ address: "me@example.org" });
  assert.equal((await sendTestEmailNotification(env)).status, "sent");
  assert.deepEqual(env.sent[0].to, ["me@example.org"]);
  assert.match(env.sent[0].subject, /Test notification from Mailroom/);
  assert.doesNotMatch(env.sent[0].text, /Open conversation/);
});

test("surfaces provider errors from a test send", async () => {
  const env = fakeEnv({ address: "me@example.org", sendError: "destination address not verified" });
  await assert.rejects(sendTestEmailNotification(env), /destination address not verified/);
});

test("keeps the address but sends nothing while switched off", async () => {
  const env = fakeEnv({ address: "me@example.org", enabled: false });
  assert.deepEqual(await notifyNewEmailByEmail(env, input), { status: "skipped", reason: "off" });
  assert.equal(env.sent.length, 0);
});
