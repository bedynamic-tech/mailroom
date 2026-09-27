/**
 * Email signatures are rich text appended to every reply and new email an
 * Inbox sends. An Inbox uses the workspace default signature, its own, or
 * none. Signatures are stored as sanitized HTML (see rich-text.ts); plain-text
 * recipients get the text rendering after the standard "-- " delimiter.
 */
import {
  isBlankRichText,
  plainTextToHtml,
  richTextToPlainText,
  sanitizeRichText,
  type MessageBody,
} from "./rich-text.ts";

export const MAX_SIGNATURE_HTML_LENGTH = 20_000;

/** How an Inbox picks its signature: the workspace default, its own, or none. */
export type SignatureMode = "default" | "custom" | "none";
export const SIGNATURE_MODES: readonly SignatureMode[] = ["default", "custom", "none"];

/** Plain-text signature delimiter (RFC 3676 section 4.3). */
export const PLAIN_TEXT_SIGNATURE_DELIMITER = "-- ";

/** Sanitize a stored or submitted signature; blank signatures become null. */
export function normalizeSignature(html: string | null | undefined): string | null {
  if (!html) return null;
  const sanitized = sanitizeRichText(html);
  return isBlankRichText(sanitized) ? null : sanitized;
}

/**
 * Validate a signature submitted through the API. Returns the sanitized HTML
 * (null to clear it) or an error message.
 */
export function parseSignatureInput(
  value: unknown,
): { ok: true; html: string | null } | { ok: false; error: string } {
  if (value === null) return { ok: true, html: null };
  if (typeof value !== "string") return { ok: false, error: "Signature must be text" };
  if (value.length > MAX_SIGNATURE_HTML_LENGTH) {
    return { ok: false, error: "This signature is too long" };
  }
  return { ok: true, html: normalizeSignature(value) };
}

/** The signature an Inbox sends with, given its mode and the workspace default. */
export function effectiveSignature(
  mode: SignatureMode | string | null | undefined,
  inboxSignature: string | null | undefined,
  defaultSignature: string | null | undefined,
): string | null {
  if (mode === "none") return null;
  return normalizeSignature(mode === "custom" ? inboxSignature : defaultSignature);
}

export interface OutgoingBodies {
  text: string;
  /** Present when the message is rich text or carries a signature. */
  html?: string;
}

/**
 * The text and HTML parts of an outgoing email: the message body followed by
 * the Inbox signature. A plain-text message without a signature goes out as
 * text only. With a signature, the text part ends in "-- " plus the
 * signature's text and the HTML part shows it below the message.
 */
export function composeOutgoingBodies(
  body: MessageBody,
  signatureHtml: string | null | undefined,
): OutgoingBodies {
  const signature = normalizeSignature(signatureHtml);
  if (!signature && !body.html) return { text: body.text };

  const text = body.text.trimEnd();
  const signatureText = signature ? richTextToPlainText(signature) : "";
  const combinedText = [text, signatureText ? `${PLAIN_TEXT_SIGNATURE_DELIMITER}\n${signatureText}` : ""]
    .filter(Boolean)
    .join("\n\n");

  const messageHtml = body.html ?? (text ? plainTextToHtml(text) : "");
  const bodyBlock = messageHtml ? `<div>${messageHtml}</div>` : "";
  const signatureBlock = signature
    ? `<div class="mailroom-signature"${messageHtml ? ' style="margin-top:16px"' : ""}>${signature}</div>`
    : "";
  const html =
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">` +
    `${bodyBlock}${signatureBlock}</div>`;

  return { text: combinedText, html };
}
