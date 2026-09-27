import assert from "node:assert/strict";
import test from "node:test";
import {
  linkifyPlainText,
  removeRedundantGoogleRedirects,
} from "../src/shared/linkify.ts";

test("linkifies explicit web URLs while preserving surrounding text", () => {
  assert.deepEqual(linkifyPlainText("Read https://example.com/docs and www.example.org."), [
    { type: "text", value: "Read " },
    { type: "link", value: "https://example.com/docs", href: "https://example.com/docs" },
    { type: "text", value: " and " },
    { type: "link", value: "www.example.org", href: "https://www.example.org" },
    { type: "text", value: "." },
  ]);
});

test("keeps balanced URL punctuation and excludes sentence punctuation", () => {
  assert.deepEqual(linkifyPlainText("See https://example.com/a_(b)). Next step."), [
    { type: "text", value: "See " },
    { type: "link", value: "https://example.com/a_(b)", href: "https://example.com/a_(b)" },
    { type: "text", value: "). Next step." },
  ]);
});

test("does not turn the www portion of an email address into a link", () => {
  assert.deepEqual(linkifyPlainText("Contact hello@www.example.com"), [
    { type: "text", value: "Contact hello@www.example.com" },
  ]);
});

test("does not allow non-web protocols", () => {
  assert.deepEqual(linkifyPlainText("javascript:alert(1) file:///tmp/a"), [
    { type: "text", value: "javascript:alert(1) file:///tmp/a" },
  ]);
});

test("removes a Gmail redirect only when it repeats the preceding URL", () => {
  const target = "https://mcpservers.org/servers/example";
  const redirect = `<https://www.google.com/url?q=${target}&source=gmail&sa=E>`;
  assert.equal(
    removeRedundantGoogleRedirects(`Current listing:\n${target}\n${redirect}\nThanks`),
    `Current listing:\n${target}\nThanks`,
  );
});

test("preserves a Google redirect when it is not a duplicate", () => {
  const redirect = "<https://www.google.com/url?q=https://example.com&source=gmail>";
  assert.equal(removeRedundantGoogleRedirects(`Open this:\n${redirect}`), `Open this:\n${redirect}`);
});
