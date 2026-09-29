import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptBackgroundColor,
  adaptCssColors,
  adaptTextColor,
  contrastRatio,
  cssBackgrounds,
  DARK_EMAIL_BACKGROUND,
  isBrightColor,
  isPaperBackground,
  parseColor,
} from "../src/web/email-colors.ts";

test("parses hex, functional and named colors", () => {
  assert.deepEqual(parseColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor("#33333380"), { r: 51, g: 51, b: 51, a: 128 / 255 });
  assert.deepEqual(parseColor("rgb(0, 0, 255)"), { r: 0, g: 0, b: 255, a: 1 });
  assert.deepEqual(parseColor("rgba(0 0 0 / 50%)"), { r: 0, g: 0, b: 0, a: 0.5 });
  assert.deepEqual(parseColor("Black"), { r: 0, g: 0, b: 0, a: 1 });
  assert.equal(parseColor("inherit"), null);
  assert.equal(parseColor("var(--x)"), null);
});

test("dark text becomes light and light text stays", () => {
  const black = parseColor(adaptTextColor("#000"));
  assert.ok(black.r > 220 && black.g > 220 && black.b > 220);
  assert.equal(adaptTextColor("#ffffff"), "#ffffff");
  assert.equal(adaptTextColor("inherit"), "inherit");
  const link = parseColor(adaptTextColor("#1a0dab"));
  assert.ok(link.b > link.r, "a blue link stays blue");
});

test("light backgrounds become dark and brand colors keep their look", () => {
  assert.equal(adaptBackgroundColor("#ffffff"), DARK_EMAIL_BACKGROUND);
  assert.equal(adaptBackgroundColor("white"), DARK_EMAIL_BACKGROUND);
  const gray = parseColor(adaptBackgroundColor("#f4f4f4"));
  assert.ok(gray.r < 50);
  assert.equal(adaptBackgroundColor("#0055ff"), "#0055ff");
  assert.equal(adaptBackgroundColor("#222222"), "#222222");
  assert.equal(adaptBackgroundColor("transparent"), "transparent");
});

test("rewrites colors inside style attributes and style sheets only", () => {
  assert.match(
    adaptCssColors("color:#000;font-size:14px;background:#fff url(white.png)"),
    /^color:#e[0-9a-f]{5};font-size:14px;background:#16171a url\(white\.png\)$/,
  );
  assert.equal(adaptCssColors("p { font-family: Arial; }"), "p { font-family: Arial; }");
  assert.match(adaptCssColors("a:hover{color:black}"), /a:hover\{color:#[0-9a-f]{6}\}/);
  assert.match(adaptCssColors("border: 1px solid #ddd"), /^border: 1px solid #[0-9a-f]{6}$/);
  assert.doesNotMatch(adaptCssColors("border: 1px solid #ddd"), /#ddd/);
});

test("tells paper backgrounds from designed ones", () => {
  assert.ok(isPaperBackground("#ffffff"));
  assert.ok(isPaperBackground("#f2f2f2"));
  assert.ok(isPaperBackground("#e8f0fe"));
  assert.ok(isPaperBackground("transparent"));
  assert.ok(!isPaperBackground("#0055ff"));
  assert.ok(!isPaperBackground("#111111"));
  assert.deepEqual(cssBackgrounds("background-color:#fff;color:red"), { colors: ["#fff"], image: false });
  assert.equal(cssBackgrounds("background:url(hero.jpg) no-repeat").image, true);
  assert.equal(cssBackgrounds("background-image:linear-gradient(red, blue)").image, true);
});

test("keeps dark text on backgrounds that stay bright", () => {
  assert.ok(isBrightColor(adaptBackgroundColor("#ffff00")));
  assert.ok(!isBrightColor(adaptBackgroundColor("#ffffff")));
  assert.equal(
    adaptCssColors("color:#1f1f1f;background-color:#ffff00", { keepText: true }),
    "color:#1f1f1f;background-color:#ffff00",
  );
});

test("measures contrast between text and background", () => {
  assert.equal(Math.round(contrastRatio("#000", "#fff")), 21);
  assert.equal(contrastRatio("#123456", "#123456"), 1);
  assert.ok(contrastRatio("rgb(0, 0, 0)", "#111827") < 3);
  assert.equal(contrastRatio("var(--x)", "#fff"), null);
});
