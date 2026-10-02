/** The lowercase domain part of an Inbox address, such as `example.com`. */
export function mailboxDomain(address: string): string {
  const at = address.lastIndexOf("@");
  return (at === -1 ? address : address.slice(at + 1)).trim().toLowerCase();
}

/** The part of an Inbox address before the `@`. */
export function mailboxLocalPart(address: string): string {
  const at = address.lastIndexOf("@");
  return at === -1 ? address : address.slice(0, at);
}

export interface MailboxDomainGroup<T> {
  domain: string;
  mailboxes: T[];
  unread_count: number;
}

/** Groups Inboxes by domain, both sorted alphabetically. */
export function groupMailboxesByDomain<T extends { address: string; unread_count: number }>(
  mailboxes: readonly T[],
): MailboxDomainGroup<T>[] {
  const groups = new Map<string, MailboxDomainGroup<T>>();
  for (const mailbox of mailboxes) {
    const domain = mailboxDomain(mailbox.address);
    const group = groups.get(domain) ?? { domain, mailboxes: [], unread_count: 0 };
    group.mailboxes.push(mailbox);
    group.unread_count += mailbox.unread_count;
    groups.set(domain, group);
  }
  const byAddress = (a: T, b: T) => a.address.localeCompare(b.address);
  return [...groups.values()]
    .sort((a, b) => a.domain.localeCompare(b.domain))
    .map((group) => ({ ...group, mailboxes: [...group.mailboxes].sort(byAddress) }));
}
