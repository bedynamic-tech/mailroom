/**
 * Prepares a Message for the compose editor's Forward: the quoted body, its
 * attachments as files and its inline images as pasted images, within the
 * per-message attachment limits.
 */
import type { Message } from "../shared/types";
import { MAX_ATTACHMENTS_PER_MESSAGE, MAX_ATTACHMENT_TOTAL_BYTES } from "../shared/email-limits";
import { forwardedMessageHtml, forwardSubject } from "../shared/forward";
import { addPastedImage } from "./pasted-images";
import { inlineAttachmentIds, normalizeContentId } from "./inline-images";

export interface ForwardDraft {
  subject: string;
  html: string;
  files: File[];
  /** Explains attachments that could not be carried over, if any. */
  notice: string | null;
}

function parseList(raw: string | null | undefined): string[] {
  try {
    const values = JSON.parse(raw || "[]") as unknown;
    return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

async function download(id: number, name: string, type: string): Promise<File> {
  const response = await fetch(`/api/attachments/${id}`, { credentials: "same-origin" });
  if (!response.ok) throw new Error(`Attachment ${id} could not be loaded`);
  return new File([await response.blob()], name, { type: type || "application/octet-stream" });
}

export async function prepareForward(message: Message, senderName: string): Promise<ForwardDraft> {
  const from = senderName && senderName !== message.from_address
    ? `${senderName} <${message.from_address}>`
    : message.from_address;
  const date = new Date(message.created_at).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" });
  let html = forwardedMessageHtml({
    from,
    date,
    subject: message.subject,
    to: parseList(message.to_addresses),
    cc: parseList(message.cc_addresses),
    text: message.text_body,
    html: message.html_body,
  });

  const inline = message.html_body ? inlineAttachmentIds(message.html_body, message.attachments) : new Set<number>();
  const files: File[] = [];
  const left: string[] = [];
  let count = 0;
  let bytes = 0;
  const carried = new Set<string>();
  const fits = (size: number) => count + 1 <= MAX_ATTACHMENTS_PER_MESSAGE && bytes + size <= MAX_ATTACHMENT_TOTAL_BYTES;

  for (const attachment of message.attachments) {
    const name = attachment.filename || (inline.has(attachment.id) ? "image" : "attachment");
    if (inline.has(attachment.id)) {
      // Images shown in the body travel as inline images with fresh content ids.
      if (!attachment.content_id || !fits(attachment.size)) continue;
      try {
        const { contentId } = await addPastedImage(await download(attachment.id, name, attachment.content_type));
        carried.add(contentId);
        const original = normalizeContentId(attachment.content_id);
        html = html.replace(/(<img\b[^>]*\bsrc=")cid:([^"]+)"/gi, (whole, start: string, id: string) =>
          normalizeContentId(id.replace(/&amp;/g, "&")) === original ? `${start}cid:${contentId}"` : whole);
        count += 1;
        bytes += attachment.size;
      } catch {
        // The image is left out of the forward; the text still goes.
      }
      continue;
    }
    if (!fits(attachment.size)) {
      left.push(name);
      continue;
    }
    try {
      files.push(await download(attachment.id, name, attachment.content_type));
      count += 1;
      bytes += attachment.size;
    } catch {
      left.push(name);
    }
  }
  // Inline images that could not be carried over would point at nothing.
  html = html.replace(/<img\b[^>]*\bsrc="cid:([^"]*)"[^>]*>/gi, (whole, id: string) => carried.has(id) ? whole : "");

  return {
    subject: forwardSubject(message.subject),
    html,
    files,
    notice: left.length
      ? `Not attached (over the 10 file, 3 MB limit or unavailable): ${left.join(", ")}`
      : null,
  };
}
