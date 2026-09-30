import assert from "node:assert/strict";
import test from "node:test";
import {
  inlineImageContentIds,
  isBlankRichText,
  linkifyRichText,
  normalizeMessageBody,
  plainTextToHtml,
  plainTextToLinkedHtml,
  richTextToPlainText,
  sanitizeRichText,
} from "../src/shared/rich-text.ts";
import {
  composeOutgoingBodies,
  effectiveSignature,
  parseSignatureInput,
} from "../src/shared/signature.ts";

test("keeps formatting, links and lists", () => {
  const html =
    '<p><b>Jane</b> <i>Doe</i> <u>Support</u></p><ul><li>One</li></ul><a href="https://acme.com" title="Acme">Acme</a>';
  assert.equal(sanitizeRichText(html), html);
});

test("removes scripts, event handlers and unsafe links", () => {
  assert.equal(
    sanitizeRichText(
      '<div onclick="steal()">Hi<script>alert(1)</script><style>p{}</style></div><a href="javascript:alert(1)">x</a><img src="data:image/png;base64,AA"><iframe src="https://x"></iframe>',
    ),
    "<div>Hi</div><a>x</a>",
  );
  assert.equal(sanitizeRichText('<a href=" jav&#x09;ascript:alert(1)">x</a>'), "<a>x</a>");
  assert.equal(sanitizeRichText('<span style="color: red; background: url(evil)">x</span>'), '<span style="color: red">x</span>');
});

test("unwraps unknown tags, balances markup and escapes stray brackets", () => {
  assert.equal(sanitizeRichText("<custom>Hi <b>there</custom> 1 < 2 & 3"), "Hi <b>there 1 &lt; 2 &amp; 3</b>");
  assert.equal(sanitizeRichText("a &amp; b &nbsp;"), "a &amp; b &nbsp;");
  assert.equal(sanitizeRichText('<img src="https://acme.com/logo.png" alt="Acme" onerror="x">'), '<img src="https://acme.com/logo.png" alt="Acme">');
});

test("renders editor HTML as plain text with one line per block", () => {
  assert.equal(richTextToPlainText("<div>Hello</div><div><br></div><div>Thanks</div>"), "Hello\n\nThanks");
  assert.equal(richTextToPlainText("<div>One</div><div>Two</div>"), "One\nTwo");
  assert.equal(richTextToPlainText("Line<br>Next"), "Line\nNext");
  assert.equal(richTextToPlainText("<p>First</p><p>Second</p>"), "First\n\nSecond");
  assert.equal(richTextToPlainText("<ul><li>A</li><li>B</li></ul><ol><li>C</li></ol>"), "- A\n- B\n1. C");
  assert.equal(
    richTextToPlainText('Visit <a href="https://acme.com/help">our help center</a> or <a href="https://acme.com">https://acme.com</a> or <a href="mailto:hi@acme.com">hi@acme.com</a>'),
    "Visit our help center <https://acme.com/help> or https://acme.com or hi@acme.com",
  );
  assert.equal(richTextToPlainText("<b>Tom &amp; Jerry</b>&nbsp;Inc"), "Tom & Jerry Inc");
});

test("plain text becomes escaped HTML with links", () => {
  assert.equal(plainTextToHtml("a < b\nsee https://acme.com"), 'a &lt; b<br>see <a href="https://acme.com">https://acme.com</a>');
});

test("pasted plain text links web and email addresses", () => {
  assert.equal(
    plainTextToLinkedHtml("Hi & bye\r\nhttps://acme.com/x?a=1&b=2 or hi@acme.com"),
    'Hi &amp; bye<br><a href="https://acme.com/x?a=1&amp;b=2">https://acme.com/x?a=1&amp;b=2</a> or <a href="mailto:hi@acme.com">hi@acme.com</a>',
  );
});

test("links bare addresses in rich text but leaves existing links alone", () => {
  assert.equal(
    linkifyRichText('<p>See https://acme.com &amp; <a href="https://x.com">https://y.com</a></p><p><b>hi@acme.com</b> &nbsp;</p>'),
    '<p>See <a href="https://acme.com">https://acme.com</a> &amp; <a href="https://x.com">https://y.com</a></p><p><b><a href="mailto:hi@acme.com">hi@acme.com</a></b> &nbsp;</p>',
  );
});

test("a rich-text body derives its text part; blank HTML is empty", () => {
  assert.deepEqual(normalizeMessageBody("ignored", "<div><b>Hi</b></div><div>there</div>"), {
    text: "Hi\nthere",
    html: "<div><b>Hi</b></div><div>there</div>",
  });
  assert.deepEqual(normalizeMessageBody("  plain  ", undefined), { text: "plain", html: null });
  assert.deepEqual(normalizeMessageBody("", "<div><br></div>"), { text: "", html: null });
  assert.equal(isBlankRichText("<p> </p>"), true);
  assert.equal(isBlankRichText('<img src="https://acme.com/a.png">'), false);
});

test("an Inbox signs with its own signature, the default, or none", () => {
  assert.equal(effectiveSignature("default", "<b>Own</b>", "<b>Default</b>"), "<b>Default</b>");
  assert.equal(effectiveSignature("custom", "<b>Own</b>", "<b>Default</b>"), "<b>Own</b>");
  assert.equal(effectiveSignature("none", "<b>Own</b>", "<b>Default</b>"), null);
  assert.equal(effectiveSignature("custom", "<p></p>", "<b>Default</b>"), null);
  assert.deepEqual(parseSignatureInput("<b>Hi</b><script>x</script>"), { ok: true, html: "<b>Hi</b>" });
  assert.equal(parseSignatureInput(42).ok, false);
});

test("outgoing email appends the signature to both parts", () => {
  const plain = composeOutgoingBodies({ text: "Thanks!", html: null }, '<b>Jane</b><br><a href="https://acme.com">Acme</a>');
  assert.equal(plain.text, "Thanks!\n\n-- \nJane\nAcme <https://acme.com>");
  assert.match(plain.html, /<div>Thanks!<\/div><div class="mailroom-signature" style="margin-top:16px"><b>Jane<\/b><br><a href="https:\/\/acme.com">Acme<\/a><\/div>/);

  assert.deepEqual(composeOutgoingBodies({ text: "Thanks!", html: null }, null), { text: "Thanks!" });

  const rich = composeOutgoingBodies({ text: "Hi", html: "<b>Hi</b>" }, null);
  assert.equal(rich.text, "Hi");
  assert.match(rich.html, /<div><b>Hi<\/b><\/div>/);
});

test("keeps images sent inline through cid links and lists their ids", () => {
  const html = '<p>Look</p><img src="cid:a1@mailroom" alt=""><img src="cid:a1@mailroom"><img src="blob:https://x/1">';
  assert.equal(sanitizeRichText(html), '<p>Look</p><img src="cid:a1@mailroom" alt=""><img src="cid:a1@mailroom">');
  assert.deepEqual(inlineImageContentIds(sanitizeRichText(html)), ["a1@mailroom"]);
});
