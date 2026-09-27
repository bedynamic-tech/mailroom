import { isEmailAddress } from "../../shared/recipients.ts";
import { CONTACT_FIELD_LIMITS } from "../../shared/contacts.ts";

export { CONTACT_FIELD_LIMITS };

export type ContactField = keyof typeof CONTACT_FIELD_LIMITS;

export const CONTACT_FIELDS = Object.keys(CONTACT_FIELD_LIMITS) as ContactField[];

export type ContactFields = Partial<Record<ContactField, string | null>>;

/**
 * Validates the editable Contact fields present in `body`. Blank values clear
 * the field (stored as null). Returns the cleaned fields or an error message.
 */
export function parseContactFields(
  body: Record<string, unknown>,
): { fields: ContactFields } | { error: string } {
  const fields: ContactFields = {};
  for (const field of CONTACT_FIELDS) {
    const value = body[field];
    if (value === undefined) continue;
    if (value !== null && typeof value !== "string") return { error: `${field} must be text` };
    const trimmed = value?.trim() ?? "";
    if (trimmed.length > CONTACT_FIELD_LIMITS[field]) return { error: `${field} is too long` };
    if (field !== "notes" && /[\r\n]/.test(trimmed)) return { error: `${field} must be one line` };
    fields[field] = trimmed || null;
  }
  return { fields };
}

/** Lowercases and validates a Contact address; returns null if it is not usable. */
export function normalizeContactAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  return isEmailAddress(address) ? address : null;
}

/**
 * Keeps Contacts in step with inbound mail from an external sender. An
 * existing Contact gets its last-seen time refreshed, and the sender's name
 * only fills a Contact with no name, so names edited by people are never
 * overwritten. A new Contact is created only when the sender's name could be
 * parsed and "Automatically create new contacts" is on. Mail from one of the
 * workspace's own Inboxes never produces a Contact.
 */
export async function recordSender(
  env: { DB: D1Database },
  sender: { address: string; name: string | null; seenAt: string },
): Promise<void> {
  const address = normalizeContactAddress(sender.address);
  if (!address) return;
  const name = sender.name?.trim().slice(0, CONTACT_FIELD_LIMITS.name) || null;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE contacts
       SET name = COALESCE(name, ?2),
           last_seen_at = CASE
             WHEN last_seen_at IS NULL OR last_seen_at < ?3 THEN ?3
             ELSE last_seen_at
           END
       WHERE address = ?1`,
    ).bind(address, name, sender.seenAt),
    env.DB.prepare(
      `INSERT OR IGNORE INTO contacts (address, name, last_seen_at)
       SELECT ?1, ?2, ?3
       WHERE ?2 IS NOT NULL
         AND (SELECT auto_create_contacts FROM global_settings WHERE id = 1) = 1
         AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1)`,
    ).bind(address, name, sender.seenAt),
  ]);
}
