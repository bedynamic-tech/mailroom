import assert from "node:assert/strict";
import test from "node:test";
import {
  EMPTY_REPLY_RECIPIENTS,
  readReplyRecipients,
  writeReplyRecipients,
} from "../src/web/reply-recipients.ts";

function memoryStorage() {
  const items = new Map();
  return {
    items,
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key),
  };
}

test("edited reply recipients are remembered per conversation", () => {
  const storage = memoryStorage();
  writeReplyRecipients(7, { to: ["a@example.com"], cc: ["b@example.com"], bcc: ["c@example.com"] }, storage);
  assert.deepEqual(readReplyRecipients(7, storage), {
    to: ["a@example.com"],
    cc: ["b@example.com"],
    bcc: ["c@example.com"],
  });
  assert.deepEqual(readReplyRecipients(8, storage), EMPTY_REPLY_RECIPIENTS);
});

test("an unedited To keeps following the latest inbound sender", () => {
  const storage = memoryStorage();
  writeReplyRecipients(7, { to: null, cc: ["b@example.com"], bcc: [] }, storage);
  assert.equal(readReplyRecipients(7, storage).to, null);
});

test("clearing every edit forgets the conversation", () => {
  const storage = memoryStorage();
  writeReplyRecipients(7, { to: ["a@example.com"], cc: [], bcc: [] }, storage);
  writeReplyRecipients(7, EMPTY_REPLY_RECIPIENTS, storage);
  assert.equal(storage.items.size, 0);
});

test("unreadable or missing storage falls back to defaults", () => {
  const storage = memoryStorage();
  storage.setItem("mailroom.replyRecipients.7", "{not json");
  assert.deepEqual(readReplyRecipients(7, storage), EMPTY_REPLY_RECIPIENTS);
  storage.setItem("mailroom.replyRecipients.7", JSON.stringify({ to: "x", cc: [1] }));
  assert.deepEqual(readReplyRecipients(7, storage), EMPTY_REPLY_RECIPIENTS);
  assert.deepEqual(readReplyRecipients(7, null), EMPTY_REPLY_RECIPIENTS);
  writeReplyRecipients(7, { to: ["a@example.com"], cc: [], bcc: [] }, null);
});
