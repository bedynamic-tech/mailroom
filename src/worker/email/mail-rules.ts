import {
  combineMailRuleActions,
  mailRuleMatches,
  MAX_MAIL_RULES,
  parseMailRuleInput,
  type MailRuleSubject,
} from "../../shared/mail-rules.ts";
import type { MailRule, MailRuleInput } from "../../shared/types.ts";

type Db = { DB: D1Database };

const MAIL_RULE_COLUMNS = `r.*, m.address AS mailbox_address, l.name AS label_name
  FROM mail_rules r
  LEFT JOIN mailboxes m ON m.id = r.mailbox_id
  LEFT JOIN labels l ON l.id = r.label_id`;

const BOOLEAN_FIELDS = [
  "enabled",
  "has_attachment",
  "mark_read",
  "archive",
  "skip_draft",
  "skip_notifications",
] as const;

type MailRuleRow = Omit<MailRule, (typeof BOOLEAN_FIELDS)[number]> &
  Record<(typeof BOOLEAN_FIELDS)[number], number>;

function toMailRule(row: MailRuleRow): MailRule {
  const rule = { ...row } as unknown as MailRule;
  for (const field of BOOLEAN_FIELDS) rule[field] = Boolean(row[field]);
  return rule;
}

export class MailRuleError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.status = status;
  }
}

export async function listMailRules(env: Db): Promise<MailRule[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${MAIL_RULE_COLUMNS} ORDER BY r.created_at, r.id`,
  ).all<MailRuleRow>();
  return results.map(toMailRule);
}

async function getMailRule(env: Db, id: number): Promise<MailRule | null> {
  const row = await env.DB.prepare(`SELECT ${MAIL_RULE_COLUMNS} WHERE r.id = ?`)
    .bind(id)
    .first<MailRuleRow>();
  return row ? toMailRule(row) : null;
}

export async function createMailRule(env: Db, body: unknown): Promise<MailRule> {
  const input = await validate(env, body);
  const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM mail_rules")
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_MAIL_RULES) {
    throw new MailRuleError(`You can have at most ${MAX_MAIL_RULES} rules`, 409);
  }
  const result = await env.DB.prepare(
    `INSERT INTO mail_rules
       (mailbox_id, name, enabled, from_pattern, subject_contains, body_contains, has_attachment,
        label_id, mark_read, archive, skip_draft, skip_notifications)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(...ruleValues(input))
    .run();
  const rule = await getMailRule(env, Number(result.meta.last_row_id));
  if (!rule) throw new Error("Rule was not stored");
  return rule;
}

export async function updateMailRule(env: Db, id: number, body: unknown): Promise<MailRule> {
  const input = await validate(env, body);
  const result = await env.DB.prepare(
    `UPDATE mail_rules
     SET mailbox_id = ?, name = ?, enabled = ?, from_pattern = ?, subject_contains = ?,
         body_contains = ?, has_attachment = ?, label_id = ?, mark_read = ?, archive = ?,
         skip_draft = ?, skip_notifications = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  )
    .bind(...ruleValues(input), id)
    .run();
  if (!result.meta.changes) throw new MailRuleError("Rule not found", 404);
  const rule = await getMailRule(env, id);
  if (!rule) throw new MailRuleError("Rule not found", 404);
  return rule;
}

export async function deleteMailRule(env: Db, id: number): Promise<void> {
  const result = await env.DB.prepare("DELETE FROM mail_rules WHERE id = ?").bind(id).run();
  if (!result.meta.changes) throw new MailRuleError("Rule not found", 404);
}

async function validate(env: Db, body: unknown): Promise<MailRuleInput> {
  const input = parseMailRuleInput(body);
  if ("error" in input) throw new MailRuleError(input.error, 400);
  if (input.mailbox_id !== null) {
    const inbox = await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
      .bind(input.mailbox_id)
      .first();
    if (!inbox) throw new MailRuleError("That inbox no longer exists", 400);
  }
  if (input.label_id !== null) {
    const label = await env.DB.prepare("SELECT id FROM labels WHERE id = ? AND mailbox_id = ?")
      .bind(input.label_id, input.mailbox_id)
      .first();
    if (!label) throw new MailRuleError("That label doesn't belong to the chosen inbox", 400);
  }
  return input;
}

function ruleValues(input: MailRuleInput): unknown[] {
  return [
    input.mailbox_id,
    input.name,
    input.enabled ? 1 : 0,
    input.from_pattern,
    input.subject_contains,
    input.body_contains,
    input.has_attachment ? 1 : 0,
    input.label_id,
    input.mark_read ? 1 : 0,
    input.archive ? 1 : 0,
    input.skip_draft ? 1 : 0,
    input.skip_notifications ? 1 : 0,
  ];
}

/** The enabled Mail Rules for mail to `mailboxId` that match `message`, without applying them. */
export async function matchingMailRules(
  env: Db,
  mailboxId: number,
  message: MailRuleSubject,
): Promise<MailRule[]> {
  const { results } = await env.DB.prepare(
    `SELECT ${MAIL_RULE_COLUMNS}
     WHERE r.enabled = 1 AND (r.mailbox_id IS NULL OR r.mailbox_id = ?)
     ORDER BY r.id`,
  )
    .bind(mailboxId)
    .all<MailRuleRow>();
  return results.map(toMailRule).filter((rule) => mailRuleMatches(rule, message));
}

export interface AppliedMailRules {
  ruleIds: number[];
  skipDraft: boolean;
  skipNotifications: boolean;
}

/**
 * Evaluates the enabled Mail Rules for the Inbox `mailboxId` (and those for
 * all Inboxes) against a stored inbound Message, applies the Labels, read
 * and archive actions of every match to its Conversation, and records the
 * matches. The caller honours the returned draft and notification skips.
 */
export async function applyMailRules(
  env: Db,
  args: { mailboxId: number; threadId: number; message: MailRuleSubject },
  now = new Date().toISOString(),
): Promise<AppliedMailRules> {
  const matched = await matchingMailRules(env, args.mailboxId, args.message);
  if (matched.length === 0) return { ruleIds: [], skipDraft: false, skipNotifications: false };

  const actions = combineMailRuleActions(matched);
  const ruleIds = matched.map((rule) => rule.id);
  const statements = [
    env.DB.prepare(
      `UPDATE mail_rules SET match_count = match_count + 1, last_matched_at = ?
       WHERE id IN (${ruleIds.map(() => "?").join(", ")})`,
    ).bind(now, ...ruleIds),
    ...actions.label_ids.map((labelId) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO thread_labels (thread_id, label_id)
         SELECT ?, id FROM labels WHERE id = ? AND mailbox_id = ?`,
      ).bind(args.threadId, labelId, args.mailboxId),
    ),
  ];
  if (actions.mark_read || actions.archive) {
    statements.push(
      env.DB.prepare(
        `UPDATE threads
         SET is_read = CASE WHEN ? THEN 1 ELSE is_read END,
             status = CASE WHEN ? THEN 'archived' ELSE status END
         WHERE id = ?`,
      ).bind(actions.mark_read ? 1 : 0, actions.archive ? 1 : 0, args.threadId),
    );
  }
  await env.DB.batch(statements);

  return {
    ruleIds,
    skipDraft: actions.skip_draft,
    skipNotifications: actions.skip_notifications,
  };
}
