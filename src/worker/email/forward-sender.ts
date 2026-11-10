import { forwardedSender, type ForwardedSender } from "../../shared/forwarded-sender.ts";
import { reassignSender } from "../api/thread-contact.ts";

/** A subject that says the email is a forward: "Fwd:", "Fw:" or "FW:". */
export function hasForwardPrefix(subject: string): boolean {
  return /^\s*fwd?\s*:/i.test(subject);
}

/**
 * When the "Switch forwards to the original sender" setting is on and the
 * email that started Conversation `threadId` is a forward, reassigns the
 * Conversation to the original sender named in the forwarded header, as
 * Change contact does. Returns who it now is with, or null when nothing
 * changed. The sender as received is kept on the Message.
 */
export async function switchForwardToOriginalSender(
  env: { DB: D1Database },
  input: { threadId: number; sender: string; subject: string; textBody: string },
): Promise<ForwardedSender | null> {
  if (!input.sender || !hasForwardPrefix(input.subject)) return null;
  const original = forwardedSender(input.textBody);
  if (!original || original.address === input.sender.toLowerCase()) return null;
  const [settings, ownAddress] = await Promise.all([
    env.DB.prepare("SELECT reassign_forwards FROM global_settings WHERE id = 1")
      .first<{ reassign_forwards: number }>(),
    env.DB.prepare("SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE")
      .bind(original.address)
      .first(),
  ]);
  if (!(settings?.reassign_forwards ?? 1) || ownAddress) return null;
  await reassignSender(env.DB, input.threadId, input.sender, original).run();
  return original;
}
