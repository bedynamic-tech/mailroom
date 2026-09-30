import type { OutboundAttachmentInput } from "../email/attachments.ts";
import { inlineImageContentIds, sanitizeRichText } from "../../shared/rich-text.ts";

const CONTENT_ID = /^[A-Za-z0-9._-]{1,100}@[A-Za-z0-9.-]{1,100}$/;

/**
 * Images pasted into a message body arrive as `inline_images` files, each
 * paired with the `inline_content_ids` value its `cid:` link uses. Only
 * images the sanitized body actually shows are sent, as inline attachments.
 */
export async function inlineImagesFromForm(
  form: FormData,
  html: string | undefined,
): Promise<OutboundAttachmentInput[] | { error: string }> {
  const files = form.getAll("inline_images");
  const ids = form.getAll("inline_content_ids");
  if (files.length === 0) return [];
  if (files.length !== ids.length) return { error: "Each pasted image needs its content id" };
  const shown = new Set(html ? inlineImageContentIds(sanitizeRichText(html)) : []);
  const images: OutboundAttachmentInput[] = [];
  const seen = new Set<string>();
  for (const [index, file] of files.entries()) {
    const id = ids[index];
    if (!(file instanceof File) || file.size === 0 || !file.type.startsWith("image/")) {
      return { error: "Pasted images must be non-empty image files" };
    }
    if (typeof id !== "string" || !CONTENT_ID.test(id)) return { error: "Invalid pasted image" };
    if (!shown.has(id) || seen.has(id)) continue;
    seen.add(id);
    images.push({
      filename: file.name,
      contentType: file.type,
      disposition: "inline",
      contentId: id,
      content: await file.arrayBuffer(),
    });
  }
  return images;
}
