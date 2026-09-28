import { cardTitleFromSubject } from "../../shared/board.ts";
import {
  combineMailRuleActions,
  mailRuleMatches,
  MAX_MAIL_RULES,
  parseMailRuleInput,
  type MailRuleSubject,
} from "../../shared/mail-rules.ts";
import type { MailRule, MailRuleInput } from "../../shared/types.ts";

type Db = { DB: D1Database };

const MAIL_RULE_COLUMNS = `r.*, m.address AS mailbox_address, l.name AS label_name,
    bc.name AS board_column_name,
    (SELECT COUNT(*) FROM mail_rule_forwards f
     WHERE f.rule_id = r.id AND f.status = 'sent') AS forward_count,
    (SELECT f.error FROM mail_rule_forwards f
     WHERE f.rule_id = r.id ORDER BY f.id DESC LIMIT 1) AS last_forward_error
  FROM mail_rules r
  LEFT JOIN mailboxes m ON m.id = r.mailbox_id
  LEFT JOIN labels l ON l.id = r.label_id
  LEFT JOIN board_columns bc ON bc.id = r.board_column_id`;

const BOOLEAN_FIELDS = ["enabled", "mark_read", "archive", "skip_draft", "skip_notifications"] as const;
const JSON_FIELDS = ["conditions", "forward_to", "forward_cc", "forward_bcc"] as const;

type MailRuleRow = Omit<MailRule, (typeof BOOLEAN_FIELDS)[number] | (typeof JSON_FIELDS)[number]> &
  Record<(typeof BOOLEAN_FIELDS)[number], number> &
  Record<(typeof JSON_FIELDS)[number], string>;

function toMailRule(row: MailRuleRow): MailRule {
  const rule = { ...row } as unknown as Record<string, unknown>;
  for (const field of BOOLEAN_FIELDS) rule[field] = Boolean(row[field]);
  for (const field of JSON_FIELDS) rule[field] = JSON.parse(row[field]);
  return rule as unknown as MailRule;
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
       (mailbox_id, name, enabled, conditions, label_id, mark_read, archive, skip_draft,
        skip_notifications, forward_to, forward_cc, forward_bcc, board_column_id, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
     SET mailbox_id = ?, name = ?, enabled = ?, conditions = ?, label_id = ?, mark_read = ?,
         archive = ?, skip_draft = ?, skip_notifications = ?, forward_to = ?, forward_cc = ?,
         forward_bcc = ?, board_column_id = ?, note = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
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
  if (input.board_column_id !== null) {
    const column = await env.DB.prepare("SELECT id FROM board_columns WHERE id = ?")
      .bind(input.board_column_id)
      .first();
    if (!column) throw new MailRuleError("That board column no longer exists", 400);
  }
  const recipients = [...input.forward_to, ...input.forward_cc, ...input.forward_bcc];
  if (recipients.length > 0) {
    // Forwarding into the workspace would store the same email again, or loop.
    const own = await env.DB.prepare(
      `SELECT address FROM mailboxes
       WHERE lower(address) IN (${recipients.map(() => "?").join(", ")}) LIMIT 1`,
    )
      .bind(...recipients.map((address) => address.toLowerCase()))
      .first<{ address: string }>();
    if (own) throw new MailRuleError(`${own.address} is one of this workspace's inboxes`, 400);
  }
  return input;
}

function ruleValues(input: MailRuleInput): unknown[] {
  return [
    input.mailbox_id,
    input.name,
    input.enabled ? 1 : 0,
    JSON.stringify(input.conditions),
    input.label_id,
    input.mark_read ? 1 : 0,
    input.archive ? 1 : 0,
    input.skip_draft ? 1 : 0,
    input.skip_notifications ? 1 : 0,
    JSON.stringify(input.forward_to),
    JSON.stringify(input.forward_cc),
    JSON.stringify(input.forward_bcc),
    input.board_column_id,
    input.note,
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
  return results.map(toMailRule).filter((rule) => mailRuleMatches(rule.conditions, message));
}

export interface RuleForward {
  ruleId: number;
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface AppliedMailRules {
  ruleIds: number[];
  skipDraft: boolean;
  skipNotifications: boolean;
  /** One forward per matching rule that forwards; the caller sends them. */
  forwards: RuleForward[];
}

export const NO_MAIL_RULES: AppliedMailRules = {
  ruleIds: [],
  skipDraft: false,
  skipNotifications: false,
  forwards: [],
};

/**
 * Evaluates the enabled Mail Rules for the Inbox `mailboxId` (and those for
 * all Inboxes) against a stored inbound Message, applies the Labels, read,
 * archive, note and board item actions of every match to its Conversation,
 * and records the matches. The caller honours the returned skips and sends the forwards.
 */
export async function applyMailRules(
  env: Db,
  args: { mailboxId: number; threadId: number; message: MailRuleSubject },
  now = new Date().toISOString(),
): Promise<AppliedMailRules> {
  const matched = await matchingMailRules(env, args.mailboxId, args.message);
  if (matched.length === 0) return NO_MAIL_RULES;

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
  // Each rule adds its own Internal Note. Notes stay in the workspace: they
  // are never part of a forward, reply or notification.
  for (const rule of matched) {
    if (rule.note === null) continue;
    statements.push(
      env.DB.prepare(
        "INSERT INTO thread_notes (thread_id, text_body, mail_rule_id, created_at) VALUES (?, ?, ?, ?)",
      ).bind(args.threadId, rule.note, rule.id, now),
    );
  }
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
  if (actions.board_column_id !== null) {
    await createRuleBoardCard(env, actions.board_column_id, args.threadId, args.message.subject);
  }

  return {
    ruleIds,
    skipDraft: actions.skip_draft,
    skipNotifications: actions.skip_notifications,
    forwards: matched
      .filter((rule) => rule.forward_to.length > 0)
      .map((rule) => ({ ruleId: rule.id, to: rule.forward_to, cc: rule.forward_cc, bcc: rule.forward_bcc })),
  };
}

/**
 * Adds a Card for the Conversation to the end of the Column, linked to it.
 * A Conversation already on the Board gets no second Card, so replies to it
 * don't pile up Cards.
 */
async function createRuleBoardCard(env: Db, columnId: number, threadId: number, subject: string): Promise<void> {
  const title = cardTitleFromSubject(subject) || "(no subject)";
  const card = await env.DB.prepare(
    `INSERT INTO board_cards (column_id, title, position)
     SELECT ?1, ?2, (SELECT COALESCE(MAX(position) + 1, 0) FROM board_cards WHERE column_id = ?1)
     WHERE EXISTS (SELECT 1 FROM board_columns WHERE id = ?1)
       AND NOT EXISTS (SELECT 1 FROM board_card_threads WHERE thread_id = ?3)
     RETURNING id`,
  )
    .bind(columnId, title, threadId)
    .first<{ id: number }>();
  if (!card) return;
  await env.DB.prepare("INSERT OR IGNORE INTO board_card_threads (card_id, thread_id) VALUES (?, ?)")
    .bind(card.id, threadId)
    .run();
}
