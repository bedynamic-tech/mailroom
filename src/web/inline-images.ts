import type { Attachment } from "../shared/types";

/**
 * Attachments the HTML body shows in place through cid: links, such as
 * signature logos. They are part of the message, not files someone sent.
 */
export function inlineAttachmentIds(html: string, attachments: Attachment[]): Set<Attachment["id"]> {
  const referenced = new Set(
    [...html.matchAll(/cid:([^"'\s)>]+)/gi)].map((match) => normalizeContentId(match[1])),
  );
  return new Set(
    attachments
      .filter((attachment) => attachment.content_id && referenced.has(normalizeContentId(attachment.content_id)))
      .map((attachment) => attachment.id),
  );
}

export function normalizeContentId(value: string): string {
  const decoded = safeDecodeURIComponent(value.trim());
  return decoded.replace(/^<|>$/g, "").trim().toLowerCase();
}

function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
