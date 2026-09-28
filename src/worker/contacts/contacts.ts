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

/** Most email addresses one Contact can have. */
export const MAX_CONTACT_ADDRESSES = 20;

/**
 * Validates a Contact's full list of addresses, primary first. Addresses are
 * lowercased and repeats dropped. Returns the cleaned list or an error message.
 */
export function parseContactAddresses(value: unknown): { addresses: string[] } | { error: string } {
  if (!Array.isArray(value)) return { error: "addresses must be a list" };
  const addresses: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string" && entry.trim() === "") continue;
    const address = normalizeContactAddress(entry);
    if (!address) {
      const label = typeof entry === "string" ? entry.trim().slice(0, 254) : String(entry);
      return { error: `${label} is not a valid email address` };
    }
    if (!addresses.includes(address)) addresses.push(address);
  }
  if (addresses.length === 0) return { error: "A contact needs at least one email address" };
  if (addresses.length > MAX_CONTACT_ADDRESSES) {
    return { error: `A contact can have at most ${MAX_CONTACT_ADDRESSES} email addresses` };
  }
  return { addresses };
}

/**
 * Keeps Contacts in step with inbound mail from an external sender. The
 * Contact that has the sender's address, primary or not, gets its last-seen
 * time refreshed, and the sender's name only fills a Contact with no name, so
 * names edited by people are never overwritten. A new Contact is created only
 * when no Contact has the address, the sender's name could be parsed and
 * "Automatically create new contacts" is on. Mail from one of the workspace's
 * own Inboxes never produces a Contact.
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
       WHERE id IN (SELECT contact_id FROM contact_addresses WHERE address = ?1)`,
    ).bind(address, name, sender.seenAt),
    env.DB.prepare(
      `INSERT OR IGNORE INTO contacts (address, name, last_seen_at)
       SELECT ?1, ?2, ?3
       WHERE ?2 IS NOT NULL
         AND (SELECT auto_create_contacts FROM global_settings WHERE id = 1) = 1
         AND NOT EXISTS (SELECT 1 FROM mailboxes WHERE address = ?1)
         AND NOT EXISTS (SELECT 1 FROM contact_addresses WHERE address = ?1)`,
    ).bind(address, name, sender.seenAt),
  ]);
}

