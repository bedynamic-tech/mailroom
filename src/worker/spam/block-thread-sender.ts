import { domainOf } from "../../shared/blocked-senders.ts";
import type { BlockedSender, BlockSenderResult } from "../../shared/types.ts";
import {
  addBlockedSender,
  BLOCKED_SENDER_COLUMNS,
  BlockRuleError,
  senderMatchCondition,
} from "./blocklist.ts";

export type BlockKind = "address" | "domain";
export type BlockScope = "inbox" | "all";

export class BlockThreadSenderError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404) {
    super(message);
    this.status = status;
  }
}

/**
 * Blocks a Conversation's latest external sender, by address or by domain,
 * either for the Conversation's Inbox or for all Inboxes, and archives the
 * Conversation. Other open Conversations from the sender within the same
 * scope are archived too. A sender that is already blocked reuses the rule.
 */
export async function blockThreadSender(
  env: { DB: D1Database },
  threadId: number,
  kind: BlockKind,
  scope: BlockScope,
): Promise<BlockSenderResult> {
  const thread = await env.DB.prepare("SELECT id, mailbox_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: number; mailbox_id: number }>();
  if (!thread) throw new BlockThreadSenderError("Conversation not found", 404);

  const sender = await env.DB.prepare(
    `SELECT lower(from_address) AS address FROM messages
     WHERE thread_id = ? AND direction = 'inbound' AND from_address LIKE '_%@_%'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(threadId)
    .first<{ address: string }>();
  if (!sender) throw new BlockThreadSenderError("This conversation has no sender to block", 400);

  const pattern = kind === "domain" ? domainOf(sender.address) : sender.address;
  const mailboxId = scope === "inbox" ? thread.mailbox_id : null;
  const rule = await addBlockedSender(env, pattern, mailboxId).catch(async (error) => {
    if (!(error instanceof BlockRuleError) || error.existingId === undefined) throw error;
    const existing = await env.DB.prepare(`SELECT ${BLOCKED_SENDER_COLUMNS} WHERE b.id = ?`)
      .bind(error.existingId)
      .first<BlockedSender>();
    if (!existing) throw error;
    return existing;
  });

  const match = senderMatchCondition(rule);
  const result = await env.DB.prepare(
    `UPDATE threads SET status = 'archived', is_read = 1
     WHERE id = ?
        OR (status <> 'archived' AND (? IS NULL OR mailbox_id = ?) AND id IN (
          SELECT msg.thread_id FROM messages msg
          WHERE msg.direction = 'inbound' AND ${match.sql}
        ))`,
  )
    .bind(threadId, rule.mailbox_id, rule.mailbox_id, ...match.bindings)
    .run();
  return { blocked: rule, archived: Number(result.meta.changes ?? 0) };
}
