import type { Attachment } from "../shared/types";
import {
  adaptBackgroundColor,
  adaptCssColors,
  adaptTextColor,
  cssBackgrounds,
  DARK_EMAIL_BACKGROUND,
  DARK_EMAIL_LINK,
  DARK_EMAIL_TEXT,
  isBrightColor,
  isPaperBackground,
} from "./email-colors";
import { normalizeContentId } from "./inline-images";

// Background colors on these mark words, not layout (a highlighted phrase).
const INLINE_ELEMENTS = new Set(["span", "font", "mark", "b", "strong", "i", "em", "u", "a", "s", "small", "code"]);

/**
 * How an HTML email is colored. "original" is exactly what the sender sent,
 * on white. "dark" is dark colors: the email's own dark styles when it has
 * them, otherwise its colors remapped for a dark background.
 */
export type EmailAppearance = "original" | "dark";

const BLOCKED_ELEMENTS = [
  "script",
  "iframe",
  "object",
  "embed",
  "form",
  "input",
  "button",
  "textarea",
  "select",
  "option",
  "link",
  "meta",
  "base",
].join(",");

const BASE_STYLE = `
  body {
    box-sizing: border-box;
    margin: 0;
    min-width: 0 !important;
    max-width: 100% !important;
    overflow-wrap: anywhere;
    font-family: Arial, Helvetica, sans-serif;
    line-height: 1.5;
  }
  *, *::before, *::after { box-sizing: border-box; }
  table { max-width: 100% !important; }
  img { max-width: 100% !important; height: auto; }
  a { overflow-wrap: anywhere; }
`;

const LIGHT_STYLE = `
  :root { color-scheme: only light; }
  html { background: #fff; }
  body { color: #172033; }
`;

// The email's own dark styles apply; it only needs a dark canvas and text
// default for the parts it leaves unstyled.
const NATIVE_DARK_STYLE = `
  :root { color-scheme: light dark; }
`;

const ADAPTED_DARK_STYLE = `
  :root { color-scheme: only dark; }
  html { background: ${DARK_EMAIL_BACKGROUND}; }
  body { color: ${DARK_EMAIL_TEXT}; }
  a { color: ${DARK_EMAIL_LINK}; }
  hr { border-color: #3a3c42; }
`;

const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'unsafe-inline'",
  "img-src 'self' https: http: data:",
  "font-src data:",
  "connect-src 'none'",
  "media-src 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join("; ");

/**
 * The appearance an email gets in dark mode unless the reader picks another:
 * dark when the email supports dark mode itself or is simple enough to recolor
 * safely, original when it is designed around its own backgrounds.
 */
export function defaultDarkAppearance(html: string): EmailAppearance {
  const document = new DOMParser().parseFromString(html, "text/html");
  return supportsDarkMode(document) || !isDesigned(document) ? "dark" : "original";
}

export function buildEmailHtmlDocument(
  html: string,
  attachments: Attachment[],
  appearance: EmailAppearance = "original",
): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  const nativeDark = appearance === "dark" && supportsDarkMode(document);
  document.querySelectorAll(BLOCKED_ELEMENTS).forEach((element) => element.remove());

  for (const element of document.querySelectorAll("*")) {
    for (const attribute of [...element.attributes]) {
      const name = attribute.name.toLowerCase();
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        name === "formaction" ||
        name === "action" ||
        name === "ping"
      ) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  const attachmentsByContentId = new Map(
    attachments
      .filter((attachment) => attachment.content_id)
      .map((attachment) => [normalizeContentId(attachment.content_id!), attachment.id]),
  );

  for (const image of document.querySelectorAll("img")) {
    image.removeAttribute("srcset");
    image.setAttribute("loading", "lazy");
    image.setAttribute("referrerpolicy", "no-referrer");
    const source = image.getAttribute("src")?.trim() ?? "";
    if (/^cid:/i.test(source)) {
      const attachmentId = attachmentsByContentId.get(normalizeContentId(source.slice(4)));
      if (attachmentId) image.setAttribute("src", `/api/attachments/${attachmentId}`);
      else image.removeAttribute("src");
    } else if (!isAllowedImageSource(source)) {
      image.removeAttribute("src");
    }
  }

  for (const link of document.querySelectorAll("a, area")) {
    const destination = safeLinkDestination(link.getAttribute("href") ?? "");
    if (!destination) {
      link.removeAttribute("href");
      link.removeAttribute("target");
      continue;
    }
    link.setAttribute("href", destination);
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener noreferrer");
    link.removeAttribute("download");
  }

  const csp = document.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = CONTENT_SECURITY_POLICY;
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  const viewport = document.createElement("meta");
  viewport.name = "viewport";
  viewport.content = "width=device-width, initial-scale=1";
  if (appearance === "dark" && !nativeDark) adaptColors(document);
  else pinColorScheme(document, nativeDark ? "dark" : "light");

  const style = document.createElement("style");
  style.textContent =
    BASE_STYLE +
    (appearance === "original" ? LIGHT_STYLE : nativeDark ? NATIVE_DARK_STYLE : ADAPTED_DARK_STYLE);
  document.head.prepend(csp, referrer, viewport, style);

  return `<!doctype html>${document.documentElement.outerHTML}`;
}

/** The email declares its own dark mode styles. */
function supportsDarkMode(document: Document): boolean {
  const declared = [...document.querySelectorAll("meta")].some((meta) => {
    const name = meta.getAttribute("name")?.toLowerCase();
    return (
      (name === "color-scheme" || name === "supported-color-schemes") &&
      /\bdark\b/i.test(meta.getAttribute("content") ?? "")
    );
  });
  if (declared) return true;
  return [...document.querySelectorAll("style")].some((style) =>
    /prefers-color-scheme\s*:\s*dark/i.test(style.textContent ?? ""),
  );
}

/**
 * The email is laid out on its own backgrounds: a background image, or a
 * background color that is not white, light gray or a pale tint. Recoloring
 * those would change the design, so they keep their original colors.
 */
function isDesigned(document: Document): boolean {
  if (document.querySelector("[background]")) return true;
  const backgrounds = [...document.querySelectorAll("[bgcolor]")].map(
    (element) => element.getAttribute("bgcolor") ?? "",
  );
  const css = [
    ...[...document.querySelectorAll("style")].map((style) => style.textContent ?? ""),
    ...[...document.querySelectorAll("[style]")]
      .filter((element) => !INLINE_ELEMENTS.has(element.localName))
      .map((element) => element.getAttribute("style") ?? ""),
  ];
  for (const text of css) {
    const found = cssBackgrounds(text);
    if (found.image) return true;
    backgrounds.push(...found.colors);
  }
  return backgrounds.some((color) => !isPaperBackground(color));
}

/**
 * Makes the email's prefers-color-scheme rules follow the chosen appearance
 * instead of the device, which can differ from the app's theme setting.
 */
function pinColorScheme(document: Document, scheme: "light" | "dark"): void {
  const always = "(min-width: 0px)";
  const never = "(max-width: -1px)";
  for (const style of document.querySelectorAll("style")) {
    style.textContent = (style.textContent ?? "").replace(
      /\(\s*prefers-color-scheme\s*:\s*(light|dark)\s*\)/gi,
      (_, value: string) => (value.toLowerCase() === scheme ? always : never),
    );
  }
}

/** Rewrites the email's own colors for a dark background. */
function adaptColors(document: Document): void {
  for (const style of document.querySelectorAll("style")) {
    style.textContent = adaptCssColors(style.textContent ?? "");
  }
  for (const element of document.querySelectorAll<HTMLElement>("[style]")) {
    const style = element.getAttribute("style") ?? "";
    // Text on a background that stays bright (a yellow highlight) keeps its
    // dark color, and gets one when it would inherit the light default.
    const bright = cssBackgrounds(style).colors.some((color) =>
      isBrightColor(adaptBackgroundColor(color)),
    );
    let adapted = adaptCssColors(style, { keepText: bright });
    if (bright && !/(^|[;\s])color\s*:/i.test(style)) adapted += ";color:#172033";
    element.setAttribute("style", adapted);
  }
  for (const element of document.querySelectorAll("[bgcolor]")) {
    element.setAttribute("bgcolor", adaptBackgroundColor(element.getAttribute("bgcolor") ?? ""));
  }
  for (const element of document.querySelectorAll("font[color]")) {
    element.setAttribute("color", adaptTextColor(element.getAttribute("color") ?? ""));
  }
  for (const attribute of ["text", "link", "vlink", "alink"]) {
    const value = document.body.getAttribute(attribute);
    if (value) document.body.setAttribute(attribute, adaptTextColor(value));
  }
}

function isAllowedImageSource(value: string): boolean {
  if (!value) return false;
  if (/^data:image\//i.test(value)) return true;
  try {
    const url = new URL(value, window.location.origin);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function safeLinkDestination(value: string): string | null {
  const destination = value.trim();
  if (!destination) return null;
  if (destination.startsWith("#")) return destination;
  if (destination.startsWith("//")) return `https:${destination}`;
  try {
    const url = new URL(destination);
    return ["http:", "https:", "mailto:", "tel:"].includes(url.protocol)
      ? destination
      : null;
  } catch {
    return null;
  }
}
