import { blockCandidates, parseBlockPattern } from "./blocked-senders.ts";
import type { MailRuleActions, MailRuleConditions, MailRuleInput } from "./types.ts";

export const MAX_MAIL_RULE_NAME_LENGTH = 80;
export const MAX_MAIL_RULE_TEXT_LENGTH = 200;
export const MAX_MAIL_RULES = 100;

/** The parts of an inbound Message that Mail Rule conditions look at. */
export interface MailRuleSubject {
  fromAddress: string;
  fromName: string | null;
  subject: string;
  body: string;
  /** Attachments, not counting inline resources such as signature images. */
  attachmentCount: number;
}

/**
 * Validates a Mail Rule from an API request body. Every text field is trimmed
 * and blank values become null. A rule needs at least one condition and one
 * action, and only a rule for one Inbox may apply a Label.
 */
export function parseMailRuleInput(value: unknown): MailRuleInput | { error: string } {
  if (!value || typeof value !== "object") return { error: "Invalid rule" };
  const body = value as Record<string, unknown>;

  const mailboxId = body.mailbox_id ?? null;
  if (mailboxId !== null && !isPositiveId(mailboxId)) {
    return { error: "Choose an inbox, or all inboxes" };
  }
  const labelId = body.label_id ?? null;
  if (labelId !== null && !isPositiveId(labelId)) return { error: "Choose a label" };
  if (labelId !== null && mailboxId === null) {
    return { error: "Labels belong to one inbox. Choose that inbox to apply a label." };
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return { error: "Give the rule a name" };
  if (name.length > MAX_MAIL_RULE_NAME_LENGTH) {
    return { error: `Rule names can be at most ${MAX_MAIL_RULE_NAME_LENGTH} characters` };
  }

  const texts: Record<"from_pattern" | "subject_contains" | "body_contains", string | null> = {
    from_pattern: null,
    subject_contains: null,
    body_contains: null,
  };
  for (const field of Object.keys(texts) as Array<keyof typeof texts>) {
    const raw = body[field] ?? null;
    if (raw !== null && typeof raw !== "string") return { error: `Invalid ${field}` };
    const text = raw?.trim() ?? "";
    if (text.length > MAX_MAIL_RULE_TEXT_LENGTH) {
      return { error: `Conditions can be at most ${MAX_MAIL_RULE_TEXT_LENGTH} characters` };
    }
    texts[field] = text || null;
  }

  const flags = {
    enabled: body.enabled ?? true,
    has_attachment: body.has_attachment ?? false,
    mark_read: body.mark_read ?? false,
    archive: body.archive ?? false,
    skip_draft: body.skip_draft ?? false,
    skip_notifications: body.skip_notifications ?? false,
  };
  for (const [field, flag] of Object.entries(flags)) {
    if (typeof flag !== "boolean") return { error: `Invalid ${field}` };
  }

  const rule: MailRuleInput = {
    mailbox_id: mailboxId as number | null,
    name,
    enabled: flags.enabled as boolean,
    ...texts,
    has_attachment: flags.has_attachment as boolean,
    label_id: labelId as number | null,
    mark_read: flags.mark_read as boolean,
    archive: flags.archive as boolean,
    skip_draft: flags.skip_draft as boolean,
    skip_notifications: flags.skip_notifications as boolean,
  };
  if (!hasCondition(rule)) return { error: "Add at least one condition" };
  if (!hasAction(rule)) return { error: "Choose at least one action" };
  return rule;
}

export function hasCondition(rule: MailRuleConditions): boolean {
  return Boolean(rule.from_pattern || rule.subject_contains || rule.body_contains || rule.has_attachment);
}

export function hasAction(rule: MailRuleActions): boolean {
  return Boolean(
    rule.label_id !== null || rule.mark_read || rule.archive || rule.skip_draft || rule.skip_notifications,
  );
}

/** Whether every condition the rule sets holds for the Message. */
export function mailRuleMatches(rule: MailRuleConditions, message: MailRuleSubject): boolean {
  if (rule.from_pattern && !fromMatches(rule.from_pattern, message.fromAddress, message.fromName)) {
    return false;
  }
  if (rule.subject_contains && !containsText(message.subject, rule.subject_contains)) return false;
  if (rule.body_contains && !containsText(message.body, rule.body_contains)) return false;
  if (rule.has_attachment && message.attachmentCount === 0) return false;
  return true;
}

/**
 * A From condition that is an email address matches that sender exactly; a
 * domain ("example.com", "@example.com") matches the domain and its
 * subdomains; anything else matches text in the sender's name or address.
 */
export function fromMatches(pattern: string, address: string, name: string | null): boolean {
  const parsed = parseBlockPattern(pattern);
  if (!("error" in parsed)) return blockCandidates(address).includes(parsed.pattern);
  return containsText(address, pattern) || containsText(name ?? "", pattern);
}

/** The combined actions of every rule that matched one Message. */
export function combineMailRuleActions(
  rules: MailRuleActions[],
): Omit<MailRuleActions, "label_id"> & { label_ids: number[] } {
  return {
    label_ids: [...new Set(rules.flatMap((rule) => (rule.label_id === null ? [] : [rule.label_id])))],
    mark_read: rules.some((rule) => rule.mark_read),
    archive: rules.some((rule) => rule.archive),
    skip_draft: rules.some((rule) => rule.skip_draft),
    skip_notifications: rules.some((rule) => rule.skip_notifications),
  };
}

function containsText(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.trim().toLowerCase());
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
