import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewEmailNotification,
  validatePushSubscription,
} from "../src/worker/notifications/push.ts";

test("builds a concise notification that opens the exact conversation", () => {
  assert.deepEqual(
    buildNewEmailNotification({
      threadId: 42,
      senderName: "  Alice   Customer  ",
      senderAddress: "alice@example.com",
      subject: "  Refund   request  ",
    }),
    {
      title: "New email from Alice Customer",
      body: "Refund request",
      tag: "conversation-42",
      data: { url: "/inbox/42" },
    },
  );
});

test("falls back safely when sender and subject are empty", () => {
  const payload = buildNewEmailNotification({
    threadId: 7,
    senderName: null,
    senderAddress: "",
    subject: "",
  });
  assert.equal(payload.title, "New email from Unknown sender");
  assert.equal(payload.body, "(no subject)");
});

test("accepts only complete HTTPS Push Subscriptions", () => {
  const valid = {
    endpoint: "https://push.example.com/subscriptions/abc",
    expirationTime: null,
    keys: {
      p256dh: "B".repeat(87),
      auth: "a".repeat(22),
    },
  };
  assert.equal(validatePushSubscription(valid), true);
  assert.equal(validatePushSubscription({ ...valid, endpoint: "http://push.example.com/abc" }), false);
  assert.equal(validatePushSubscription({ ...valid, keys: { ...valid.keys, auth: "short" } }), false);
  assert.equal(validatePushSubscription({ ...valid, expirationTime: -1 }), false);
});
