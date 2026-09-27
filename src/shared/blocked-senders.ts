import { isEmailAddress } from "./recipients.ts";

export type BlockedSenderKind = "address" | "domain";

const DOMAIN_PATTERN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/;

/**
 * Parses what a person typed into a block rule. An email address blocks that
 * one sender; a domain (optionally written "@example.com" or "*.example.com")
 * blocks everyone at the domain and its subdomains.
 */
export function parseBlockPattern(
  value: unknown,
): { kind: BlockedSenderKind; pattern: string } | { error: string } {
  if (typeof value !== "string") return { error: "Enter an email address or domain" };
  const input = value.trim().toLowerCase();
  if (!input) return { error: "Enter an email address or domain" };
  if (/^[^@]+@[^@]+$/.test(input)) {
    return isEmailAddress(input) && DOMAIN_PATTERN.test(domainOf(input))
      ? { kind: "address", pattern: input }
      : { error: "That isn't a valid email address" };
  }
  const domain = input.replace(/^\*\./, "").replace(/^@/, "").replace(/\.$/, "");
  return DOMAIN_PATTERN.test(domain)
    ? { kind: "domain", pattern: domain }
    : { error: "Enter an email address or a domain such as example.com" };
}

export function domainOf(address: string): string {
  return address.slice(address.lastIndexOf("@") + 1).toLowerCase();
}

/**
 * The rule patterns that would block `address`: the address itself, its
 * domain, and each parent domain that still has a dot (never a bare TLD).
 */
export function blockCandidates(address: string): string[] {
  const normalized = address.trim().toLowerCase();
  if (!normalized.includes("@")) return [];
  const labels = domainOf(normalized).split(".").filter(Boolean);
  const candidates = [normalized];
  for (let i = 0; i < labels.length - 1; i++) candidates.push(labels.slice(i).join("."));
  return candidates;
}

// Blocking one of these domains would reject mail from every customer who uses it.
const SHARED_MAIL_DOMAINS = new Set([
  "aol.com",
  "fastmail.com",
  "gmail.com",
  "gmx.com",
  "gmx.de",
  "googlemail.com",
  "hey.com",
  "hotmail.com",
  "icloud.com",
  "live.com",
  "mail.com",
  "me.com",
  "msn.com",
  "outlook.com",
  "proton.me",
  "protonmail.com",
  "qq.com",
  "yahoo.com",
  "yandex.com",
  "zoho.com",
]);

/** Whether `domain` is a public mailbox provider shared by unrelated people. */
export function isSharedMailDomain(domain: string): boolean {
  return SHARED_MAIL_DOMAINS.has(domain.toLowerCase());
}
