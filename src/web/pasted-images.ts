/**
 * Images pasted or dropped into a message body. They are kept in memory until
 * the message is sent: the message HTML refers to each through a `cid:` link,
 * the editor shows it from a blob URL, and sending uploads it as an inline
 * attachment with that Content-ID.
 */
import { inlineImageContentIds } from "../shared/rich-text";

interface PastedImage {
  file: File;
  url: string;
}

const images = new Map<string, PastedImage>();

/** Larger images, and formats not every email app shows, are re-encoded. */
const KEEP_AS_IS_BYTES = 600 * 1024;
const KEEP_AS_IS_TYPES = new Set(["image/png", "image/jpeg", "image/gif"]);
const MAX_EDGE_PIXELS = 1600;

export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/");
}

/** Keep a pasted image for sending and return the `cid:` id and blob URL that stand for it. */
export async function addPastedImage(file: File): Promise<{ contentId: string; url: string }> {
  const prepared = await prepareImage(file);
  const contentId = `${crypto.randomUUID()}@mailroom`;
  const url = URL.createObjectURL(prepared);
  images.set(contentId, { file: prepared, url });
  return { contentId, url };
}

/** Editor HTML shows pasted images from their blob URLs. */
export function withPastedImageUrls(html: string): string {
  return html.replace(/(<img\b[^>]*\bsrc=")cid:([^"]+)"/gi, (whole, start: string, id: string) => {
    const image = images.get(id);
    return image ? `${start}${image.url}"` : whole;
  });
}

/** Message HTML refers to pasted images through `cid:` links. */
export function withPastedImageContentIds(html: string): string {
  if (images.size === 0) return html;
  const byUrl = new Map([...images].map(([id, image]) => [image.url, id]));
  return html.replace(/(<img\b[^>]*\bsrc=")(blob:[^"]+)"/gi, (whole, start: string, url: string) => {
    const id = byUrl.get(url);
    return id ? `${start}cid:${id}"` : whole;
  });
}

/** The pasted images a message shows, to upload with it. */
export function pastedImagesIn(html: string): Array<{ contentId: string; file: File }> {
  return inlineImageContentIds(html).flatMap((contentId) => {
    const image = images.get(contentId);
    return image ? [{ contentId, file: image.file }] : [];
  });
}

async function prepareImage(file: File): Promise<File> {
  if (file.size <= KEEP_AS_IS_BYTES && KEEP_AS_IS_TYPES.has(file.type)) return file;
  // Animated GIFs would lose their animation on a canvas.
  if (file.type === "image/gif") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_EDGE_PIXELS / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext("2d");
    if (!context) return file;
    // JPEG has no transparency; show transparent parts on white as most emails do.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.88));
    if (!blob || (blob.size >= file.size && KEEP_AS_IS_TYPES.has(file.type))) return file;
    const name = (file.name || "image").replace(/\.[^.]*$/, "") || "image";
    return new File([blob], `${name}.jpg`, { type: "image/jpeg" });
  } catch {
    return file;
  }
}

/** Drop `cid:` images that are not pasted images of this session, e.g. ones copied from another email. */
export function withoutUnknownInlineImages(html: string, keepPasted: boolean): string {
  return html.replace(/<img\b[^>]*\bsrc="cid:([^"]*)"[^>]*>/gi, (whole, id: string) =>
    keepPasted && images.has(id) ? whole : "",
  );
}
