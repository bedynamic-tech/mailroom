/**
 * An Inbox's sender name is the display name recipients see in the From
 * header, e.g. "Jane Doe from Acme" <support@acme.com>. It must stay on one
 * line so it can never inject extra headers.
 */
export const MAX_SENDER_NAME_LENGTH = 100;

export function normalizeSenderName(value: string | null | undefined): string {
  return (value ?? "").replace(/[\u0000-\u001f\u007f\s]+/g, " ").trim();
}

export function senderFrom(
  address: string,
  displayName: string | null | undefined,
): { address: string; name?: string } {
  const name = normalizeSenderName(displayName).slice(0, MAX_SENDER_NAME_LENGTH);
  return name ? { address, name } : { address };
}
