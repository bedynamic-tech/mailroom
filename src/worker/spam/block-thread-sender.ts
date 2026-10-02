import { domainOf } from "../../shared/blocked-senders.ts";
import type { BlockedSender, BlockSenderResult, BulkBlockSenderResult } from "../../shared/types.ts";
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
 * Blocks a sender on a Conversation, by address or by domain, either for the
 * Conversation's Inbox or for all Inboxes. The sender is `address` when given,
 * which must appear on one of the Conversation's Messages (From, To or Cc),
 * or else the latest external sender. Open Conversations the blocked sender
 * wrote to within the scope are archived, this one included when they wrote
 * to it. A sender that is already blocked reuses the rule.
 */
export async function blockThreadSender(
  env: { DB: D1Database },
  threadId: number,
  kind: BlockKind,
  scope: BlockScope,
  address?: string,
): Promise<BlockSenderResult> {
  const thread = await env.DB.prepare("SELECT id, mailbox_id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: number; mailbox_id: number }>();
  if (!thread) throw new BlockThreadSenderError("Conversation not found", 404);

  const sender = address === undefined
    ? await env.DB.prepare(
        `SELECT lower(from_address) AS address FROM messages
         WHERE thread_id = ? AND direction = 'inbound' AND from_address LIKE '_%@_%'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
      )
        .bind(threadId)
        .first<{ address: string }>()
    : await env.DB.prepare(
        `SELECT lower(?2) AS address FROM messages msg
         WHERE msg.thread_id = ?1 AND (
           msg.from_address = ?2 COLLATE NOCASE
           OR EXISTS (SELECT 1 FROM json_each(COALESCE(msg.to_addresses, '[]')) WHERE value = ?2 COLLATE NOCASE)
           OR EXISTS (SELECT 1 FROM json_each(COALESCE(msg.cc_addresses, '[]')) WHERE value = ?2 COLLATE NOCASE)
         )
         LIMIT 1`,
      )
        .bind(threadId, address.trim())
        .first<{ address: string }>();
  if (!sender) {
    throw new BlockThreadSenderError(
      address === undefined
        ? "This conversation has no sender to block"
        : "That address isn't on this conversation",
      400,
    );
  }

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

  // The latest sender's Conversation is always archived; a chosen address
  // archives it only when that address wrote to it, like the others.
  const match = senderMatchCondition(rule);
  const result = await env.DB.prepare(
    `UPDATE threads SET status = 'archived', is_read = 1
     WHERE id = ?
        OR (status <> 'archived' AND (? IS NULL OR mailbox_id = ?) AND id IN (
          SELECT msg.thread_id FROM messages msg
          WHERE msg.direction = 'inbound' AND ${match.sql}
        ))`,
  )
    .bind(address === undefined ? threadId : 0, rule.mailbox_id, rule.mailbox_id, ...match.bindings)
    .run();
  return { blocked: rule, archived: Number(result.meta.changes ?? 0) };
}

/**
 * Marks the senders of several Conversations as spam: blocks each one's
 * latest external sender by address, on its own Inbox or on all Inboxes, and
 * archives what that block archives. Conversations without a sender that can
 * be blocked, such as ones only sent from here, are skipped.
 */
export async function blockThreadSenders(
  env: { DB: D1Database },
  threadIds: number[],
  scope: BlockScope,
): Promise<BulkBlockSenderResult> {
  const blocked = new Map<number, BlockedSender>();
  let skipped = 0;
  for (const threadId of threadIds) {
    try {
      const result = await blockThreadSender(env, threadId, "address", scope);
      blocked.set(result.blocked.id, result.blocked);
    } catch (error) {
      if (!(error instanceof BlockThreadSenderError || error instanceof BlockRuleError)) throw error;
      skipped += 1;
    }
  }
  return { blocked: [...blocked.values()], skipped };
}
