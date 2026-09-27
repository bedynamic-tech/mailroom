/** Splits a free-form address field ("a@x.com, b@y.com; c@z.com") into addresses. */
export function splitAddressInput(value: string): string[] {
  return value.split(/[\s,;]+/).map((address) => address.trim()).filter(Boolean);
}

export interface RecipientLists {
  to: string[];
  cc: string[];
  bcc: string[];
}

/**
 * Removes duplicates within and across To, Cc and Bcc (case-insensitively),
 * keeping each address in the most visible field it appears in.
 */
export function dedupeRecipients(lists: RecipientLists): RecipientLists {
  const seen = new Set<string>();
  const keep = (addresses: string[]) =>
    addresses.filter((address) => {
      const key = address.trim().toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { to: keep(lists.to), cc: keep(lists.cc), bcc: keep(lists.bcc) };
}

/** Trims an address and lowercases its domain; the local part is case-sensitive. */
export function normalizeEmailAddress(address: string): string {
  const trimmed = address.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0) return trimmed;
  return `${trimmed.slice(0, at)}@${trimmed.slice(at + 1).toLowerCase()}`;
}
