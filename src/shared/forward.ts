/**
 * Forwarding a Message by hand: the subject and the quoted body that open in
 * the compose editor. Pure string handling, so it runs in the browser and
 * Node tests alike.
 */
import { escapeHtml, plainTextToHtml, sanitizeRichText } from "./rich-text.ts";

/** "Fwd: " before the subject, unless it already starts with Fwd: or Fw:. */
export function forwardSubject(subject: string): string {
  return /^\s*fwd?\s*:/i.test(subject) ? subject.trim() : `Fwd: ${subject.trim() || "(no subject)"}`;
}

export interface ForwardSource {
  from: string;
  date: string;
  subject: string;
  to: string[];
  cc: string[];
  text: string | null;
  html: string | null;
}

/**
 * The editor body for a forward: a blank line to write in, then the
 * forwarded-message header (From, Date, Subject, To, Cc) and the original
 * body, as rich text that has passed the allowlist.
 */
export function forwardedMessageHtml(source: ForwardSource): string {
  const header = [
    "---------- Forwarded message ---------",
    `From: ${source.from}`,
    `Date: ${source.date}`,
    `Subject: ${source.subject || "(no subject)"}`,
    source.to.length ? `To: ${source.to.join(", ")}` : null,
    source.cc.length ? `Cc: ${source.cc.join(", ")}` : null,
  ].filter((line): line is string => line !== null).map(escapeHtml).join("<br>");
  const body = source.html ? sanitizeRichText(source.html) : plainTextToHtml((source.text ?? "").trim());
  return sanitizeRichText(`<p><br></p><p>${header}</p><p><br></p><div>${body}</div>`);
}
