import {
  blockCandidates,
  isSharedMailDomain,
  parseBlockPattern,
  type BlockedSenderKind,
} from "../../shared/blocked-senders.ts";
import type { BlockedSender } from "../../shared/types.ts";

type Db = { DB: D1Database };

/**
 * Returns the Blocked Sender rule matching any of `senders`, recording the
 * rejection on it, or null when none of them is blocked.
 */
export async function matchBlockedSender(
  env: Db,
  senders: string[],
  now = new Date().toISOString(),
): Promise<BlockedSender | null> {
  const candidates = [...new Set(senders.flatMap(blockCandidates))];
  if (candidates.length === 0) return null;
  const rule = await env.DB.prepare(
    `SELECT * FROM blocked_senders
     WHERE pattern IN (${candidates.map(() => "?").join(", ")})
     ORDER BY kind = 'address' DESC, length(pattern) DESC LIMIT 1`,
  )
    .bind(...candidates)
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
 * Validates and stores a Blocked Sender rule. Rules that would block one of
 * the workspace's own Inboxes, or a public mailbox provider such as gmail.com,
 * are refused.
 */
export async function addBlockedSender(env: Db, value: unknown): Promise<BlockedSender> {
  const parsed = parseBlockPattern(value);
  if ("error" in parsed) throw new BlockRuleError(parsed.error, 400);
  await assertBlockable(env, parsed);

  const existing = await env.DB.prepare("SELECT id FROM blocked_senders WHERE pattern = ?")
    .bind(parsed.pattern)
    .first<{ id: number }>();
  if (existing) {
    throw new BlockRuleError(`${parsed.pattern} is already blocked`, 409, existing.id);
  }
  const rule = await env.DB.prepare(
    "INSERT INTO blocked_senders (kind, pattern) VALUES (?, ?) RETURNING *",
  )
    .bind(parsed.kind, parsed.pattern)
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
