import { domainOf, isBlockedSenderAction } from "../../shared/blocked-senders.ts";
import type {
  BlockedSender,
  BlockedSenderAction,
  BlockSenderResult,
  BulkBlockSenderResult,
} from "../../shared/types.ts";
import {
  ConversationDeletionError,
  deleteArchivedConversations,
} from "../inbox/delete-conversations.ts";
import {
  addBlockedSender,
  BLOCKED_SENDER_COLUMNS,
  BlockRuleError,
  senderMatchCondition,
} from "./blocklist.ts";

export type BlockKind = "address" | "domain";
export type BlockScope = "inbox" | "all";

export interface BlockOptions {
  /** Receives R2 keys left unreferenced by deleted Conversations, to purge. */
  onObjectsFreed?: (keys: string[]) => void;
}

/** The global Blocked sender action; archive unless set otherwise. */
export async function blockedSenderAction(db: D1Database): Promise<BlockedSenderAction> {
  const row = await db.prepare("SELECT blocked_sender_action AS action FROM global_settings WHERE id = 1")
    .first<{ action: string }>();
  return isBlockedSenderAction(row?.action) ? row.action : "archive";
}

// Deletion takes at most 99 Conversations per call when open ones are included.
const DELETE_CHUNK = 99;

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
 * or else the latest external sender. What happens to the blocked sender's
 * Conversations within the scope follows the global Blocked sender action:
 * open ones are archived, or all of them, archived ones too, are permanently
 * deleted. This one is included when they wrote to it. Conversations with an
 * email still sending are archived instead of deleted. A sender that is
 * already blocked reuses the rule.
 */
export async function blockThreadSender(
  env: { DB: D1Database },
  threadId: number,
  kind: BlockKind,
  scope: BlockScope,
  address?: string,
  options: BlockOptions & { action?: BlockedSenderAction } = {},
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

  // The latest sender's Conversation is always included; a chosen address
  // includes it only when that address wrote to it, like the others.
  const action = options.action ?? await blockedSenderAction(env.DB);
  const match = senderMatchCondition(rule);
  const includeThis = address === undefined ? threadId : 0;
  if (action === "archive") {
    const result = await env.DB.prepare(
      `UPDATE threads SET status = 'archived', is_read = 1
       WHERE id = ?
          OR (status <> 'archived' AND (? IS NULL OR mailbox_id = ?) AND id IN (
            SELECT msg.thread_id FROM messages msg
            WHERE msg.direction = 'inbound' AND ${match.sql}
          ))`,
    )
      .bind(includeThis, rule.mailbox_id, rule.mailbox_id, ...match.bindings)
      .run();
    return { blocked: rule, archived: Number(result.meta.changes ?? 0), deleted: 0, deleted_ids: [] };
  }

  const { results } = await env.DB.prepare(
    `SELECT id, EXISTS (
       SELECT 1 FROM reply_attempts active
       WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending')
       UNION ALL
       SELECT 1 FROM outbound_attempts active
       WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending')
     ) AS sending
     FROM threads
     WHERE id = ?
        OR ((? IS NULL OR mailbox_id = ?) AND id IN (
          SELECT msg.thread_id FROM messages msg
          WHERE msg.direction = 'inbound' AND ${match.sql}
        ))
     ORDER BY id`,
  )
    .bind(includeThis, rule.mailbox_id, rule.mailbox_id, ...match.bindings)
    .all<{ id: number; sending: number }>();
  // A Conversation with an email still sending can't be deleted; it is
  // archived below with anything else that couldn't be.
  const targets = results.map((row) => row.id);
  const deletable = results.filter((row) => !row.sending).map((row) => row.id);
  const deletedIds: number[] = [];
  for (let index = 0; index < deletable.length; index += DELETE_CHUNK) {
    const ids = deletable.slice(index, index + DELETE_CHUNK);
    try {
      const deleted = await deleteArchivedConversations(env, {
        ids,
        includeOpen: true,
      });
      deletedIds.push(...deleted.ids);
      if (deleted.objectKeys.length > 0) options.onObjectsFreed?.(deleted.objectKeys);
    } catch (error) {
      if (!(error instanceof ConversationDeletionError)) throw error;
    }
  }

  // Anything that couldn't be deleted, such as a Conversation with an email
  // still sending, is archived so it still leaves the inbox.
  const deletedSet = new Set(deletedIds);
  const kept = targets.filter((id) => !deletedSet.has(id));
  let archived = 0;
  if (kept.length > 0) {
    const result = await env.DB.prepare(
      `UPDATE threads SET status = 'archived', is_read = 1
       WHERE status <> 'archived' AND id IN (${kept.map(() => "?").join(", ")})`,
    )
      .bind(...kept)
      .run();
    archived = Number(result.meta.changes ?? 0);
  }
  return { blocked: rule, archived, deleted: deletedIds.length, deleted_ids: deletedIds };
}

/**
 * Marks the senders of several Conversations as spam: blocks each one's
 * latest external sender by address, on its own Inbox or on all Inboxes, and
 * archives or deletes what that block does. Conversations without a sender
 * that can be blocked, such as ones only sent from here, are skipped, and so
 * are ones an earlier block in the same request already deleted.
 */
export async function blockThreadSenders(
  env: { DB: D1Database },
  threadIds: number[],
  scope: BlockScope,
  options: BlockOptions = {},
): Promise<BulkBlockSenderResult> {
  const action = await blockedSenderAction(env.DB);
  const blocked = new Map<number, BlockedSender>();
  const deleted = new Set<number>();
  let skipped = 0;
  let archived = 0;
  for (const threadId of threadIds) {
    if (deleted.has(threadId)) continue;
    try {
      const result = await blockThreadSender(env, threadId, "address", scope, undefined, {
        ...options,
        action,
      });
      blocked.set(result.blocked.id, result.blocked);
      archived += result.archived;
      for (const id of result.deleted_ids) deleted.add(id);
    } catch (error) {
      if (!(error instanceof BlockThreadSenderError || error instanceof BlockRuleError)) throw error;
      skipped += 1;
    }
  }
  return { blocked: [...blocked.values()], skipped, archived, deleted: deleted.size };
}
