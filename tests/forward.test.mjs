import assert from "node:assert/strict";
import test from "node:test";
import { forwardedMessageHtml, forwardSubject } from "../src/shared/forward.ts";
import { richTextToPlainText } from "../src/shared/rich-text.ts";

test("forwardSubject adds Fwd: once", () => {
  assert.equal(forwardSubject("Invoice 42"), "Fwd: Invoice 42");
  assert.equal(forwardSubject("FW: Invoice 42"), "FW: Invoice 42");
  assert.equal(forwardSubject(" fwd:Invoice "), "fwd:Invoice");
  assert.equal(forwardSubject(""), "Fwd: (no subject)");
});

test("forwardedMessageHtml quotes the header and a plain-text body", () => {
  const html = forwardedMessageHtml({
    from: "Jane <jane@example.com>",
    date: "Oct 1, 2026, 12:17 PM",
    subject: "Refund <urgent>",
    to: ["support@acme.com"],
    cc: [],
    text: "Hi,\nsee https://acme.com",
    html: null,
  });
  assert.match(html, /^<p><br><\/p>/);
  assert.match(html, /From: Jane &lt;jane@example.com&gt;/);
  assert.match(html, /<a href="https:\/\/acme.com">/);
  assert.doesNotMatch(html, /Cc:/);
  assert.equal(
    richTextToPlainText(html),
    "---------- Forwarded message ---------\nFrom: Jane <jane@example.com>\nDate: Oct 1, 2026, 12:17 PM\nSubject: Refund <urgent>\nTo: support@acme.com\n\n\nHi,\nsee https://acme.com",
  );
});

test("forwardedMessageHtml sanitizes an HTML body", () => {
  const html = forwardedMessageHtml({
    from: "jane@example.com", date: "today", subject: "Hi", to: [], cc: ["a@b.com"],
    text: "ignored", html: '<html><head><style>p{}</style></head><body><p onclick="x()"><b>Bold</b></p><script>bad()</script></body></html>',
  });
  assert.match(html, /Cc: a@b.com/);
  assert.match(html, /<p><b>Bold<\/b><\/p>/);
  assert.doesNotMatch(html, /script|onclick|style/);
});
