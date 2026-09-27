import {
  blockCandidates,
  isSharedMailDomain,
  parseBlockPattern,
  type BlockedSenderKind,
} from "../../shared/blocked-senders.ts";
import type { BlockedSender } from "../../shared/types.ts";

type Db = { DB: D1Database };

export const BLOCKED_SENDER_COLUMNS = `b.*, m.address AS mailbox_address
  FROM blocked_senders b LEFT JOIN mailboxes m ON m.id = b.mailbox_id`;

/**
 * Returns the Blocked Sender rule matching any of `senders` for mail arriving
 * at the Inbox `mailboxId`, recording the rejection on it, or null when none
 * of them is blocked there. Rules for all Inboxes and for this Inbox apply.
 */
export async function matchBlockedSender(
  env: Db,
  mailboxId: number,
  senders: string[],
  now = new Date().toISOString(),
): Promise<BlockedSender | null> {
  const candidates = [...new Set(senders.flatMap(blockCandidates))];
  if (candidates.length === 0) return null;
  const rule = await env.DB.prepare(
    `SELECT ${BLOCKED_SENDER_COLUMNS}
     WHERE b.pattern IN (${candidates.map(() => "?").join(", ")})
       AND (b.mailbox_id IS NULL OR b.mailbox_id = ?)
     ORDER BY b.kind = 'address' DESC, length(b.pattern) DESC, b.mailbox_id IS NULL
     LIMIT 1`,
  )
    .bind(...candidates, mailboxId)
    .first<BlockedSender>();
  if (!rule) return null;
  await env.DB.prepare(
    `UPDATE blocked_senders
     SET blocked_count = blocked_count + 1, last_blocked_at = ?
     WHERE id = ?`,
  )
    .bind(now, rule.id)
    .run();
  return rule;
}

export class BlockRuleError extends Error {
  readonly status: 400 | 409;
  /** The rule already blocking the same pattern, on a 409. */
  readonly existingId?: number;

  constructor(message: string, status: 400 | 409, existingId?: number) {
    super(message);
    this.status = status;
    this.existingId = existingId;
  }
}

/**
 * Validates and stores a Blocked Sender rule for one Inbox, or for all Inboxes
 * when `mailboxId` is null. A rule for all Inboxes replaces any per-Inbox
 * rules for the same pattern. Rules that would block one of the workspace's
 * own Inboxes, or a public mailbox provider such as gmail.com, are refused.
 */
export async function addBlockedSender(
  env: Db,
  value: unknown,
  mailboxId: number | null,
): Promise<BlockedSender> {
  const parsed = parseBlockPattern(value);
  if ("error" in parsed) throw new BlockRuleError(parsed.error, 400);
  await assertBlockable(env, parsed);
  if (mailboxId !== null) {
    const inbox = await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ?")
      .bind(mailboxId)
      .first();
    if (!inbox) throw new BlockRuleError("That inbox no longer exists", 400);
  }

  const existing = await env.DB.prepare(
    `SELECT ${BLOCKED_SENDER_COLUMNS}
     WHERE b.pattern = ? AND (b.mailbox_id IS NULL OR b.mailbox_id IS ?)
     ORDER BY b.mailbox_id IS NULL DESC LIMIT 1`,
  )
    .bind(parsed.pattern, mailboxId)
    .first<BlockedSender>();
  if (existing) {
    const where = existing.mailbox_address ? `for ${existing.mailbox_address}` : "for all inboxes";
    throw new BlockRuleError(`${parsed.pattern} is already blocked ${where}`, 409, existing.id);
  }

  const [inserted] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blocked_senders (mailbox_id, kind, pattern) VALUES (?, ?, ?)",
    ).bind(mailboxId, parsed.kind, parsed.pattern),
    env.DB.prepare(
      "DELETE FROM blocked_senders WHERE ? IS NULL AND pattern = ? AND mailbox_id IS NOT NULL",
    ).bind(mailboxId, parsed.pattern),
  ]);
  const rule = await env.DB.prepare(`SELECT ${BLOCKED_SENDER_COLUMNS} WHERE b.id = ?`)
    .bind(Number(inserted.meta.last_row_id))
    .first<BlockedSender>();
  if (!rule) throw new Error("Blocked sender was not stored");
  return rule;
}

async function assertBlockable(
  env: Db,
  rule: { kind: BlockedSenderKind; pattern: string },
): Promise<void> {
  if (rule.kind === "domain" && isSharedMailDomain(rule.pattern)) {
    throw new BlockRuleError(
      `${rule.pattern} is shared by many unrelated people. Block the sender's address instead.`,
      400,
    );
  }
  const { results: inboxes } = await env.DB.prepare("SELECT address FROM mailboxes")
    .all<{ address: string }>();
  const ownInbox = inboxes.find((inbox) => blockCandidates(inbox.address).includes(rule.pattern));
  if (ownInbox) {
    throw new BlockRuleError(
      `Blocking ${rule.pattern} would block this workspace's inbox ${ownInbox.address.toLowerCase()}`,
      400,
    );
  }
}

/**
 * SQL condition and bindings matching inbound messages (aliased `msg`) whose
 * sender falls under `rule`.
 */
export function senderMatchCondition(rule: Pick<BlockedSender, "kind" | "pattern">): {
  sql: string;
  bindings: string[];
} {
  if (rule.kind === "address") {
    return { sql: "msg.from_address = ? COLLATE NOCASE", bindings: [rule.pattern] };
  }
  const escaped = rule.pattern.replace(/[\\%_]/g, (char) => `\\${char}`);
  return {
    sql: "(msg.from_address LIKE ? ESCAPE '\\' OR msg.from_address LIKE ? ESCAPE '\\')",
    bindings: [`%@${escaped}`, `%@%.${escaped}`],
  };
}
