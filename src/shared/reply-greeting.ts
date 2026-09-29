/**
 * Reply greeting: an optional first line, such as "Jane,", that a
 * Conversation's reply box starts with, followed by a blank line so the
 * cursor sits where the reply begins. The template is plain text where
 * {first_name} stands for the recipient's first name.
 */
import { escapeHtml, sanitizeRichText } from "./rich-text.ts";

export const FIRST_NAME_PLACEHOLDER = "{first_name}";
export const DEFAULT_REPLY_GREETING_TEMPLATE = `${FIRST_NAME_PLACEHOLDER},`;
export const MAX_REPLY_GREETING_LENGTH = 200;

/**
 * A first name from a display name: "Jane Doe" and "Doe, Jane" give "Jane".
 * All-caps names are title-cased. Returns null when there is no usable name,
 * e.g. when the display name is an email address.
 */
export function firstNameFrom(name: string | null | undefined): string | null {
  let value = (name ?? "").trim().replace(/^["'\s]+|["'\s]+$/g, "").trim();
  if (!value || value.includes("@")) return null;
  const parts = value.split(",").map((part) => part.trim()).filter(Boolean);
  // "Last, First": the given name follows the comma.
  if (parts.length === 2 && !/\s/.test(parts[0]!)) value = parts[1]!;
  const first = value.split(/\s+/)[0]!.replace(/^[^\p{L}]+|[^\p{L}'-]+$/gu, "");
  if (!first || !/\p{L}/u.test(first)) return null;
  if (first.length > 1 && first === first.toUpperCase() && first !== first.toLowerCase()) {
    return first[0] + first.slice(1).toLowerCase();
  }
  return first;
}

/** Normalize a submitted template: one trimmed line; blank uses the default. */
export function normalizeGreetingTemplate(value: string | null | undefined): string | null {
  const line = (value ?? "").replace(/\s+/g, " ").trim();
  if (!line || line === DEFAULT_REPLY_GREETING_TEMPLATE) return null;
  return line;
}

/**
 * The greeting line for a recipient, or null when the template needs a first
 * name and none is known (the reply then starts empty).
 */
export function replyGreetingLine(template: string | null, firstName: string | null): string | null {
  const line = normalizeGreetingTemplate(template) ?? DEFAULT_REPLY_GREETING_TEMPLATE;
  if (line.includes(FIRST_NAME_PLACEHOLDER) && !firstName) return null;
  return line.split(FIRST_NAME_PLACEHOLDER).join(firstName ?? "").trim() || null;
}

/** Rich text for the reply box: the greeting, a blank line and an empty line for the cursor. */
export function replyGreetingHtml(line: string): string {
  return sanitizeRichText(`<div>${escapeHtml(line)}</div><div><br></div><div><br></div>`);
}
