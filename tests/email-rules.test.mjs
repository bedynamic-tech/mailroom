import test from "node:test";
import assert from "node:assert/strict";
import {
  addressOf,
  addressesOf,
  attachmentBytes,
  hasReplyPrefix,
  isAutoSubmitted,
  normalizeSubject,
  rawFingerprint,
  replyRecipients,
} from "../src/worker/email/rules.ts";

test("normalizes localized reply subjects but only treats replies as fallback candidates", () => {
  assert.equal(normalizeSubject(" Re: AW: Fwd: Refund request "), "refund request");
  assert.equal(hasReplyPrefix("Re: Refund request"), true);
  assert.equal(hasReplyPrefix("Refund request"), false);
  assert.equal(hasReplyPrefix("Fwd: Refund request"), false);
});

test("prefers Reply-To over From and flattens address groups", () => {
  const message = {
    from: { name: "Forms", address: "no-reply@example.com" },
    replyTo: [
      { name: "Customer", address: "Customer@Example.com" },
      { name: "Supporters", group: [{ name: "Other", address: "other@example.com" }] },
    ],
  };
  assert.deepEqual(replyRecipients(message), ["customer@example.com", "other@example.com"]);
  assert.equal(addressOf(message.from), "no-reply@example.com");
  assert.deepEqual(addressesOf(message.replyTo), ["customer@example.com", "other@example.com"]);
});

test("recognizes automated mail without blocking normal Auto-Submitted: no", () => {
  const header = (key, value) => ({ key, originalKey: key, value });
  assert.equal(isAutoSubmitted({ headers: [header("auto-submitted", "no")] }), false);
  assert.equal(isAutoSubmitted({ headers: [header("auto-submitted", "auto-replied")] }), true);
  assert.equal(isAutoSubmitted({ headers: [header("list-id", "customers.example.com")] }), true);
});

test("raw fingerprints make Message-ID fallback deterministic", async () => {
  const raw = new TextEncoder().encode("Subject: hello\r\n\r\nworld").buffer;
  assert.equal(await rawFingerprint(raw), await rawFingerprint(raw));
  assert.notEqual(
    await rawFingerprint(raw),
    await rawFingerprint(new TextEncoder().encode("different").buffer),
  );
});

test("normalizes attachment content to bytes", () => {
  assert.deepEqual([...attachmentBytes("hello")], [104, 101, 108, 108, 111]);
  assert.deepEqual([...attachmentBytes(new Uint8Array([1, 2, 3]))], [1, 2, 3]);
});
