import type { Address, Email } from "postal-mime";

export function normalizeSubject(subject: string): string {
  return subject
    .replace(/^(\s*(re|fwd?|aw)\s*:\s*)+/i, "")
    .trim()
    .toLowerCase();
}

export function hasReplyPrefix(subject: string): boolean {
  return /^(\s*(re|aw)\s*:\s*)/i.test(subject);
}

export function addressOf(address: Address | undefined): string {
  if (!address || !("address" in address) || !address.address) return "";
  return address.address.trim().toLowerCase();
}

export function addressesOf(addresses: Address[] | undefined): string[] {
  if (!addresses) return [];
  return addresses.flatMap((entry) =>
    "group" in entry && entry.group
      ? entry.group.map((mailbox) => mailbox.address.trim().toLowerCase()).filter(Boolean)
      : ["address" in entry && entry.address ? entry.address.trim().toLowerCase() : ""].filter(Boolean),
  );
}

export function replyRecipients(message: Pick<Email, "replyTo" | "from">): string[] {
  const replyTo = addressesOf(message.replyTo);
  if (replyTo.length > 0) return [...new Set(replyTo)];
  const from = addressOf(message.from);
  return from ? [from] : [];
}

export async function rawFingerprint(raw: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", raw);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof content === "string") return new TextEncoder().encode(content);
  if (content instanceof Uint8Array) return content;
  return new Uint8Array(content);
}

export function isAutoSubmitted(message: Pick<Email, "headers">): boolean {
  for (const header of message.headers ?? []) {
    const key = header.key.toLowerCase();
    const value = header.value.toLowerCase();
    if (key === "auto-submitted" && value !== "no") return true;
    if (key === "precedence" && ["bulk", "junk", "list", "auto_reply"].includes(value)) return true;
    if (key === "x-auto-response-suppress") return true;
    if (key === "list-id" || key === "list-unsubscribe") return true;
  }
  return false;
}
