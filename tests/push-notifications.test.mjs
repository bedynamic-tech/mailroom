import assert from "node:assert/strict";
import test from "node:test";
import {
  buildNewEmailNotification,
  describeBrowser,
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

test("names a reply in an existing conversation as a reply", () => {
  const payload = buildNewEmailNotification({
    threadId: 7,
    isReply: true,
    senderName: "Alice",
    senderAddress: "alice@example.com",
    subject: "Re: Refund",
  });
  assert.equal(payload.title, "Reply from Alice");
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

test("names the browser behind a Push Subscription", () => {
  assert.equal(
    describeBrowser("Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:143.0) Gecko/20100101 Firefox/143.0"),
    "Firefox on macOS",
  );
  assert.equal(
    describeBrowser("Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148"),
    "Safari on iPhone",
  );
  assert.equal(
    describeBrowser("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0"),
    "Edge on Windows",
  );
  assert.equal(describeBrowser(null), "Unknown browser");
});
