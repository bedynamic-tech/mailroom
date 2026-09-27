import { blockCandidates, parseBlockPattern } from "./blocked-senders.ts";
import { dedupeRecipients, isEmailAddress, normalizeEmailAddress } from "./recipients.ts";
import type {
  MailRuleActions,
  MailRuleCondition,
  MailRuleConditionGroup,
  MailRuleConditions,
  MailRuleField,
  MailRuleInput,
  MailRuleMatch,
  MailRuleOperator,
} from "./types.ts";

export const MAX_MAIL_RULE_NAME_LENGTH = 80;
export const MAX_MAIL_RULE_TEXT_LENGTH = 200;
export const MAX_MAIL_RULES = 100;
/** Conditions across the whole rule, counting those inside groups. */
export const MAX_MAIL_RULE_CONDITIONS = 20;
/** To, Cc and Bcc recipients of one rule's forward, combined. */
export const MAX_MAIL_RULE_FORWARD_RECIPIENTS = 20;

const TEXT_OPERATORS: MailRuleOperator[] = ["contains", "not_contains", "is", "is_not", "starts_with", "ends_with"];

/** The operators each field offers, in the order the rule editor lists them. */
export const MAIL_RULE_OPERATORS: Record<MailRuleField, MailRuleOperator[]> = {
  from: [...TEXT_OPERATORS, "domain_is"],
  to: [...TEXT_OPERATORS, "domain_is"],
  cc: [...TEXT_OPERATORS, "domain_is"],
  subject: TEXT_OPERATORS,
  body: ["contains", "not_contains"],
  attachment_name: ["contains", "not_contains", "is", "ends_with"],
  has_attachment: ["yes", "no"],
};

export const MAIL_RULE_FIELD_LABELS: Record<MailRuleField, string> = {
  from: "From",
  to: "To",
  cc: "Cc",
  subject: "Subject",
  body: "Body",
  attachment_name: "Attachment name",
  has_attachment: "Has attachment",
};

export const MAIL_RULE_OPERATOR_LABELS: Record<MailRuleOperator, string> = {
  contains: "contains",
  not_contains: "does not contain",
  is: "is",
  is_not: "is not",
  starts_with: "starts with",
  ends_with: "ends with",
  domain_is: "is at domain",
  yes: "yes",
  no: "no",
};

/** Operators that take no value. */
export function operatorTakesValue(operator: MailRuleOperator): boolean {
  return operator !== "yes" && operator !== "no";
}

/** The parts of an inbound Message that Mail Rule conditions look at. */
export interface MailRuleSubject {
  from: MailRuleAddress;
  to: MailRuleAddress[];
  cc: MailRuleAddress[];
  subject: string;
  body: string;
  /** Attachments, not counting inline resources such as signature images. */
  attachmentNames: string[];
}

export interface MailRuleAddress {
  address: string;
  name: string | null;
}

export function isConditionGroup(
  item: MailRuleCondition | MailRuleConditionGroup,
): item is MailRuleConditionGroup {
  return "conditions" in item;
}

/**
 * Validates a Mail Rule from an API request body. Text is trimmed, a domain
 * condition keeps just the domain, and forward recipients are normalized and
 * deduplicated. A rule needs at least one condition and one action, and only
 * a rule for one Inbox may apply a Label.
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

  const conditions = parseConditions(body.conditions);
  if ("error" in conditions) return conditions;

  const flags = {
    enabled: body.enabled ?? true,
    mark_read: body.mark_read ?? false,
    archive: body.archive ?? false,
    skip_draft: body.skip_draft ?? false,
    skip_notifications: body.skip_notifications ?? false,
  };
  for (const [field, flag] of Object.entries(flags)) {
    if (typeof flag !== "boolean") return { error: `Invalid ${field}` };
  }

  const forward = parseForward(body);
  if ("error" in forward) return forward;

  const rule: MailRuleInput = {
    mailbox_id: mailboxId as number | null,
    name,
    enabled: flags.enabled as boolean,
    conditions,
    label_id: labelId as number | null,
    mark_read: flags.mark_read as boolean,
    archive: flags.archive as boolean,
    skip_draft: flags.skip_draft as boolean,
    skip_notifications: flags.skip_notifications as boolean,
    ...forward,
  };
  if (!hasAction(rule)) return { error: "Choose at least one action" };
  return rule;
}

function parseConditions(value: unknown): MailRuleConditions | { error: string } {
  if (!value || typeof value !== "object") return { error: "Add at least one condition" };
  const root = value as { match?: unknown; items?: unknown };
  if (!isMatch(root.match)) return { error: "Choose whether all or any conditions must match" };
  if (!Array.isArray(root.items) || root.items.length === 0) {
    return { error: "Add at least one condition" };
  }

  let total = 0;
  const items: MailRuleConditions["items"] = [];
  for (const item of root.items) {
    if (item && typeof item === "object" && "conditions" in item) {
      const group = item as { match?: unknown; conditions?: unknown };
      if (!isMatch(group.match)) return { error: "Choose whether all or any conditions in a group must match" };
      if (!Array.isArray(group.conditions) || group.conditions.length === 0) {
        return { error: "A condition group can't be empty" };
      }
      const conditions: MailRuleCondition[] = [];
      for (const entry of group.conditions) {
        const condition = parseCondition(entry);
        if ("error" in condition) return condition;
        conditions.push(condition);
      }
      total += conditions.length;
      items.push({ match: group.match, conditions });
    } else {
      const condition = parseCondition(item);
      if ("error" in condition) return condition;
      total += 1;
      items.push(condition);
    }
  }
  if (total > MAX_MAIL_RULE_CONDITIONS) {
    return { error: `A rule can have at most ${MAX_MAIL_RULE_CONDITIONS} conditions` };
  }
  return { match: root.match, items };
}

function parseCondition(value: unknown): MailRuleCondition | { error: string } {
  if (!value || typeof value !== "object") return { error: "Invalid condition" };
  const { field, operator, value: raw } = value as Record<string, unknown>;
  if (typeof field !== "string" || !(field in MAIL_RULE_OPERATORS)) return { error: "Choose a field" };
  const operators = MAIL_RULE_OPERATORS[field as MailRuleField];
  if (typeof operator !== "string" || !operators.includes(operator as MailRuleOperator)) {
    return { error: `Choose how to compare ${MAIL_RULE_FIELD_LABELS[field as MailRuleField]}` };
  }
  const condition = { field: field as MailRuleField, operator: operator as MailRuleOperator, value: "" };
  if (!operatorTakesValue(condition.operator)) return condition;

  const text = typeof raw === "string" ? raw.trim() : "";
  const label = MAIL_RULE_FIELD_LABELS[condition.field];
  if (!text) return { error: `Fill in what ${label} should be compared with` };
  if (text.length > MAX_MAIL_RULE_TEXT_LENGTH) {
    return { error: `Conditions can be at most ${MAX_MAIL_RULE_TEXT_LENGTH} characters` };
  }
  if (condition.operator === "domain_is") {
    const parsed = parseBlockPattern(text);
    if ("error" in parsed || parsed.kind !== "domain") {
      return { error: `${label} is at domain needs a domain such as example.com` };
    }
    return { ...condition, value: parsed.pattern };
  }
  return { ...condition, value: text };
}

function parseForward(
  body: Record<string, unknown>,
): Pick<MailRuleActions, "forward_to" | "forward_cc" | "forward_bcc"> | { error: string } {
  const lists: Record<"to" | "cc" | "bcc", string[]> = { to: [], cc: [], bcc: [] };
  for (const key of ["to", "cc", "bcc"] as const) {
    const raw = body[`forward_${key}`] ?? [];
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      return { error: `Invalid forward ${key} recipients` };
    }
    for (const entry of raw as string[]) {
      const address = normalizeEmailAddress(entry);
      if (!address) continue;
      if (!isEmailAddress(address)) return { error: `${address} isn't a valid email address` };
      lists[key].push(address);
    }
  }
  const deduped = dedupeRecipients(lists);
  const count = deduped.to.length + deduped.cc.length + deduped.bcc.length;
  if (count > 0 && deduped.to.length === 0) return { error: "Add a To address to forward to" };
  if (count > MAX_MAIL_RULE_FORWARD_RECIPIENTS) {
    return { error: `A rule can forward to at most ${MAX_MAIL_RULE_FORWARD_RECIPIENTS} recipients` };
  }
  return { forward_to: deduped.to, forward_cc: deduped.cc, forward_bcc: deduped.bcc };
}

export function hasAction(rule: MailRuleActions): boolean {
  return Boolean(
    rule.label_id !== null ||
      rule.mark_read ||
      rule.archive ||
      rule.skip_draft ||
      rule.skip_notifications ||
      rule.forward_to.length > 0,
  );
}

/** Whether the rule's conditions hold for the Message. */
export function mailRuleMatches(conditions: MailRuleConditions, message: MailRuleSubject): boolean {
  // "All of nothing" would match every email; a rule without conditions matches none.
  if (conditions.items.length === 0) return false;
  return combine(conditions.match, conditions.items, (item) =>
    isConditionGroup(item)
      ? combine(item.match, item.conditions, (condition) => conditionMatches(condition, message))
      : conditionMatches(item, message),
  );
}

function combine<T>(match: MailRuleMatch, items: T[], test: (item: T) => boolean): boolean {
  return match === "all" ? items.every(test) : items.some(test);
}

/**
 * Address fields compare against each address and display name they carry;
 * a positive operator matches when any of them does, and its negation
 * ("does not contain", "is not") when none does.
 */
export function conditionMatches(condition: MailRuleCondition, message: MailRuleSubject): boolean {
  const { field, operator } = condition;
  if (field === "has_attachment") {
    return (message.attachmentNames.length > 0) === (operator === "yes");
  }
  const needle = condition.value.toLowerCase();
  const addresses =
    field === "from" ? [message.from] : field === "to" ? message.to : field === "cc" ? message.cc : null;

  if (operator === "domain_is") {
    return (addresses ?? []).some((entry) => blockCandidates(entry.address).includes(needle));
  }

  const values = addresses
    ? addresses.flatMap((entry) => [entry.address, entry.name ?? ""]).filter(Boolean)
    : field === "subject"
      ? [message.subject]
      : field === "body"
        ? [message.body]
        : message.attachmentNames;
  const test = (value: string): boolean => {
    const haystack = value.trim().toLowerCase();
    switch (operator) {
      case "contains":
      case "not_contains":
        return haystack.includes(needle);
      case "is":
      case "is_not":
        return haystack === needle;
      case "starts_with":
        return haystack.startsWith(needle);
      case "ends_with":
        return haystack.endsWith(needle);
      default:
        return false;
    }
  };
  const any = values.some(test);
  return operator === "not_contains" || operator === "is_not" ? !any : any;
}

/** The combined actions of every rule that matched one Message, apart from forwards. */
export function combineMailRuleActions(rules: MailRuleActions[]): {
  label_ids: number[];
  mark_read: boolean;
  archive: boolean;
  skip_draft: boolean;
  skip_notifications: boolean;
} {
  return {
    label_ids: [...new Set(rules.flatMap((rule) => (rule.label_id === null ? [] : [rule.label_id])))],
    mark_read: rules.some((rule) => rule.mark_read),
    archive: rules.some((rule) => rule.archive),
    skip_draft: rules.some((rule) => rule.skip_draft),
    skip_notifications: rules.some((rule) => rule.skip_notifications),
  };
}

/** A one-line reading of a rule's conditions, e.g. `From contains "x" and (…or…)`. */
export function describeMailRuleConditions(conditions: MailRuleConditions): string {
  const joiner = (match: MailRuleMatch) => (match === "all" ? " and " : " or ");
  return conditions.items
    .map((item) =>
      isConditionGroup(item)
        ? `(${item.conditions.map(describeCondition).join(joiner(item.match))})`
        : describeCondition(item),
    )
    .join(joiner(conditions.match));
}

function describeCondition(condition: MailRuleCondition): string {
  const field = MAIL_RULE_FIELD_LABELS[condition.field];
  const operator = MAIL_RULE_OPERATOR_LABELS[condition.operator];
  return operatorTakesValue(condition.operator)
    ? `${field} ${operator} “${condition.value}”`
    : `${field}: ${operator}`;
}

function isMatch(value: unknown): value is MailRuleMatch {
  return value === "all" || value === "any";
}

function isPositiveId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
