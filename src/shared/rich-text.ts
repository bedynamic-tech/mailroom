/**
 * Rich text for outgoing email: message bodies and signatures written in the
 * web editor (bold, italic, links, lists, simple tables, remote images).
 * Everything is stored and sent as HTML that has passed `sanitizeRichText`,
 * so one allowlist guards the editor, the API and outgoing mail. Plain-text
 * recipients get the `richTextToPlainText` rendering.
 *
 * This module is pure string handling so it runs in the browser, the Worker
 * and Node tests alike.
 */
import { linkifyPlainText, linkifyText } from "./linkify.ts";

/** Upper bound on the HTML of one message body; the plain-text limit still applies. */
export const MAX_RICH_TEXT_HTML_LENGTH = 400_000;

const VOID_TAGS = new Set(["br", "hr", "img"]);

/** Elements dropped together with everything inside them. */
const DROPPED_WITH_CONTENT = new Set([
  "script",
  "style",
  "head",
  "title",
  "template",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "noscript",
  "textarea",
  "select",
  "button",
]);

const TABLE_CELL_ATTRIBUTES = ["colspan", "rowspan", "width", "height", "align", "valign", "bgcolor"];

/** Allowed elements and the attributes each may keep, besides `style`. */
const ALLOWED: Record<string, readonly string[]> = {
  a: ["href", "title"],
  b: [],
  strong: [],
  i: [],
  em: [],
  u: [],
  s: [],
  strike: [],
  small: [],
  sub: [],
  sup: [],
  code: [],
  br: [],
  hr: [],
  p: ["align"],
  div: ["align"],
  span: [],
  h1: ["align"],
  h2: ["align"],
  h3: ["align"],
  blockquote: [],
  ul: [],
  ol: [],
  li: [],
  font: ["color", "face", "size"],
  img: ["src", "alt", "title", "width", "height"],
  table: ["width", "align", "border", "cellpadding", "cellspacing", "bgcolor"],
  thead: [],
  tbody: [],
  tr: ["align", "valign"],
  td: TABLE_CELL_ATTRIBUTES,
  th: TABLE_CELL_ATTRIBUTES,
};

/** Elements that start and end a line in the plain-text rendering. */
const BLOCK_TAGS = new Set([
  "p",
  "div",
  "h1",
  "h2",
  "h3",
  "blockquote",
  "ul",
  "ol",
  "li",
  "table",
  "thead",
  "tbody",
  "tr",
]);

/** Blocks followed by a blank line in the plain-text rendering. */
const PARAGRAPH_TAGS = new Set(["p", "h1", "h2", "h3", "blockquote"]);

const STYLE_PROPERTIES = new Set([
  "color",
  "background-color",
  "font-weight",
  "font-style",
  "font-size",
  "font-family",
  "text-decoration",
  "text-decoration-line",
  "text-align",
  "line-height",
  "vertical-align",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "padding",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "width",
  "height",
  "max-width",
  "border",
  "border-top",
  "border-right",
  "border-bottom",
  "border-left",
  "border-collapse",
  "border-radius",
]);

const TAG_PATTERN = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/y;
const DECLARATION_PATTERN = /<[!?][^>]*>/y;
const ATTRIBUTE_PATTERN =
  /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/**
 * Keep only the email-safe subset of `html`: formatting, links to web, mail
 * and phone addresses, lists, simple tables and remote images. Anything else
 * (scripts, event handlers, forms, unknown tags) is removed, keeping the text
 * of unknown tags. The result is always balanced markup.
 */
export function sanitizeRichText(html: string): string {
  let output = "";
  const open: string[] = [];
  let index = 0;

  while (index < html.length) {
    const next = html.indexOf("<", index);
    if (next === -1) {
      output += escapeText(html.slice(index));
      break;
    }
    output += escapeText(html.slice(index, next));
    index = next;

    if (html.startsWith("<!--", index)) {
      const end = html.indexOf("-->", index + 4);
      index = end === -1 ? html.length : end + 3;
      continue;
    }

    DECLARATION_PATTERN.lastIndex = index;
    if (DECLARATION_PATTERN.test(html)) {
      index = DECLARATION_PATTERN.lastIndex;
      continue;
    }

    TAG_PATTERN.lastIndex = index;
    const match = TAG_PATTERN.exec(html);
    if (!match) {
      output += "&lt;";
      index += 1;
      continue;
    }
    index = TAG_PATTERN.lastIndex;
    const closing = match[1] === "/";
    const name = match[2]!.toLowerCase();

    if (closing) {
      const position = open.lastIndexOf(name);
      if (position === -1) continue;
      while (open.length > position) output += `</${open.pop()}>`;
      continue;
    }

    if (DROPPED_WITH_CONTENT.has(name)) {
      const closeTag = new RegExp(`</${name}\\s*>`, "ig");
      closeTag.lastIndex = index;
      const end = closeTag.exec(html);
      index = end ? closeTag.lastIndex : html.length;
      continue;
    }

    const allowed = ALLOWED[name];
    if (!allowed) continue;
    const attributes = sanitizeAttributes(name, match[3] ?? "", allowed);
    if (attributes === null) continue;
    output += `<${name}${attributes}>`;
    if (!VOID_TAGS.has(name)) open.push(name);
  }

  while (open.length) output += `</${open.pop()}>`;
  return output.trim();
}

/** True when the HTML would show nothing: no text and no image. */
export function isBlankRichText(html: string | null | undefined): boolean {
  if (!html) return true;
  return !/<img\b/i.test(html) && richTextToPlainText(html) === "";
}

/**
 * Plain-text rendering of sanitized rich text: one line per block or line
 * break, list items prefixed, link targets in angle brackets after their text
 * and images replaced by their alt text.
 */
export function richTextToPlainText(html: string): string {
  const lines: string[] = [];
  let current = "";
  // A <br> already ended the line, so the block boundary right after it must
  // not add another (editors put <br> in otherwise empty lines).
  let endedByBreak = false;
  const lists: Array<{ ordered: boolean; count: number }> = [];
  const links: Array<{ href: string; line: number; start: number }> = [];

  const endLine = () => {
    lines.push(current.trim());
    current = "";
  };
  const blockBoundary = () => {
    if (current.trim()) endLine();
    else current = "";
  };

  for (const token of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>|([^<]+)/g)) {
    const text = token[4];
    if (text !== undefined) {
      const value = decodeEntities(text.replace(/\s+/g, " ")).replace(/ /g, " ");
      if (!value.trim() && !current) continue;
      current += value;
      endedByBreak = false;
      continue;
    }

    const closing = token[1] === "/";
    const name = token[2]!.toLowerCase();
    const attributes = token[3] ?? "";

    if (name === "br") {
      endLine();
      endedByBreak = true;
      continue;
    }
    if (name === "img") {
      const alt = decodeEntities(/\balt="([^"]*)"/i.exec(attributes)?.[1] ?? "").trim();
      if (alt) current += alt;
      continue;
    }
    if (name === "hr") {
      blockBoundary();
      endedByBreak = false;
      continue;
    }
    if (name === "a") {
      if (!closing) {
        const href = decodeEntities(/\bhref="([^"]*)"/i.exec(attributes)?.[1] ?? "").trim();
        links.push({ href, line: lines.length, start: current.length });
        continue;
      }
      const link = links.pop();
      if (!link?.href) continue;
      const label =
        link.line === lines.length ? current.slice(link.start).trim() : current.trim();
      const shown = link.href.replace(/^(mailto|tel):/i, "");
      if (!label) current += shown;
      else if (!sameLinkText(label, link.href) && !sameLinkText(label, shown)) {
        current += ` <${shown}>`;
      }
      continue;
    }
    if ((name === "td" || name === "th") && closing) {
      current += " ";
      continue;
    }
    if (!BLOCK_TAGS.has(name)) continue;

    if (!endedByBreak) blockBoundary();
    endedByBreak = false;

    if (name === "ul" || name === "ol") {
      if (closing) lists.pop();
      else lists.push({ ordered: name === "ol", count: 0 });
    } else if (name === "li" && !closing) {
      const list = lists.at(-1);
      if (list) list.count += 1;
      current = `${"  ".repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${list.count}.` : "-"} `;
    } else if (name === "blockquote" && !closing) {
      current = "";
    }

    if (closing && PARAGRAPH_TAGS.has(name) && lines.at(-1) !== "") lines.push("");
  }
  if (current.trim()) endLine();

  return lines
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .replace(/^\n+|\n+$/g, "");
}

/** Escape a plain-text body as HTML, turning web addresses into links. */
export function plainTextToHtml(text: string): string {
  return text
    .split("\n")
    .map((line) =>
      linkifyPlainText(line)
        .map((segment) =>
          segment.type === "link"
            ? `<a href="${escapeAttribute(segment.href)}">${escapeHtml(segment.value)}</a>`
            : escapeHtml(segment.value),
        )
        .join(""),
    )
    .join("<br>");
}

/**
 * Plain text as editor HTML: escaped, with line breaks kept and web and email
 * addresses turned into links. Used for text pasted into the editor.
 */
export function plainTextToLinkedHtml(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => linkedSegmentsHtml(line))
    .join("<br>");
}

/**
 * Turn bare web and email addresses in sanitized HTML into links, leaving
 * existing links and markup untouched.
 */
export function linkifyRichText(html: string): string {
  let insideLink = 0;
  let output = "";
  for (const token of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)[^>]*>|[^<]+/g)) {
    const value = token[0];
    if (token[2]) {
      if (token[2].toLowerCase() === "a") insideLink = Math.max(0, insideLink + (token[1] ? -1 : 1));
      output += value;
      continue;
    }
    if (insideLink) {
      output += value;
      continue;
    }
    const decoded = decodeEntities(value);
    output += linkifyText(decoded).some((segment) => segment.type === "link")
      ? linkedSegmentsHtml(decoded)
      : value;
  }
  return output;
}

function linkedSegmentsHtml(text: string): string {
  return linkifyText(text)
    .map((segment) =>
      segment.type === "link"
        ? `<a href="${escapeAttribute(segment.href)}">${escapeHtml(segment.value)}</a>`
        : escapeHtml(segment.value),
    )
    .join("");
}

export interface MessageBody {
  /** Plain-text version, always present. */
  text: string;
  /** Sanitized HTML when the message was written as rich text. */
  html: string | null;
}

/**
 * Canonical body of an outgoing message. A rich-text body is sanitized and its
 * plain-text version derived from it, so the two parts always agree; without
 * HTML the trimmed text is used as is.
 */
export function normalizeMessageBody(text: string, html?: string | null): MessageBody {
  if (html) {
    const sanitized = sanitizeRichText(html);
    if (isBlankRichText(sanitized)) return { text: "", html: null };
    return { text: richTextToPlainText(sanitized), html: sanitized };
  }
  return { text: text.trim(), html: null };
}

function sanitizeAttributes(tag: string, source: string, allowed: readonly string[]): string | null {
  const kept = new Map<string, string>();
  for (const match of source.matchAll(ATTRIBUTE_PATTERN)) {
    const name = match[1]!.toLowerCase();
    const value = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
    if (kept.has(name)) continue;

    if (name === "style") {
      const style = sanitizeStyle(value);
      if (style) kept.set(name, style);
      continue;
    }
    if (!allowed.includes(name)) continue;

    const clean = sanitizeAttributeValue(tag, name, value);
    if (clean !== null) kept.set(name, clean);
  }

  if (tag === "img" && !kept.has("src")) return null;
  let output = "";
  for (const [name, value] of kept) output += ` ${name}="${escapeAttribute(value)}"`;
  return output;
}

function sanitizeAttributeValue(tag: string, name: string, value: string): string | null {
  const trimmed = value.trim();
  switch (name) {
    case "href":
      return safeUrl(trimmed, ["http:", "https:", "mailto:", "tel:"]);
    case "src":
      return tag === "img" ? safeUrl(trimmed, ["http:", "https:"]) : null;
    case "width":
    case "height":
    case "border":
    case "cellpadding":
    case "cellspacing":
    case "colspan":
    case "rowspan":
      return /^\d{1,4}%?$/.test(trimmed) ? trimmed : null;
    case "size":
      return /^[1-7]$/.test(trimmed) ? trimmed : null;
    case "align":
      return /^(left|right|center|justify)$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    case "valign":
      return /^(top|middle|bottom|baseline)$/i.test(trimmed) ? trimmed.toLowerCase() : null;
    case "color":
    case "bgcolor":
      return /^(#[0-9a-f]{3,8}|[a-z]{3,20})$/i.test(trimmed) ? trimmed : null;
    case "face":
      return /^[\w\s,'"-]{1,100}$/.test(trimmed) ? trimmed : null;
    case "alt":
    case "title":
      return value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300);
    default:
      return null;
  }
}

function safeUrl(value: string, protocols: string[]): string | null {
  if (!value || /[\u0000-\u001f\u007f]/.test(value)) return null;
  const normalized = value.startsWith("//") ? `https:${value}` : value;
  try {
    const url = new URL(normalized);
    return protocols.includes(url.protocol) ? normalized : null;
  } catch {
    return null;
  }
}

function sanitizeStyle(value: string): string {
  const declarations: string[] = [];
  for (const part of value.split(";")) {
    const colon = part.indexOf(":");
    if (colon === -1) continue;
    const property = part.slice(0, colon).trim().toLowerCase();
    const propertyValue = part.slice(colon + 1).trim();
    if (!STYLE_PROPERTIES.has(property) || !propertyValue || propertyValue.length > 200) continue;
    if (!/^[#\w\s.,%'"()+\-\/!]*$/.test(propertyValue)) continue;
    if (/url\s*\(|expression|javascript|behavior|binding|@import/i.test(propertyValue)) continue;
    declarations.push(`${property}: ${propertyValue}`);
  }
  return declarations.join("; ");
}

function sameLinkText(label: string, href: string): boolean {
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/^(https?:)?\/\//, "")
      .replace(/^www\./, "")
      .replace(/\/$/, "");
  return normalize(label) === normalize(href);
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  copy: "©",
  reg: "®",
  trade: "™",
  middot: "·",
  bull: "•",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
};

function decodeEntities(value: string): string {
  return value.replace(/&(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});/gi, (entity, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1] === "x" || body[1] === "X" ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
}

/** Escape text that may already contain entities, without double-escaping them. */
function escapeText(value: string): string {
  return value
    .replace(/&(?!(#\d{1,7}|#x[0-9a-f]{1,6}|[a-z][a-z0-9]{1,31});)/gi, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}
