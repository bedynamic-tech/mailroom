import { domainOf } from "../../shared/blocked-senders.ts";
import type { BlockedSender, SpamReportResult } from "../../shared/types.ts";
import { addBlockedSender, BlockRuleError, senderMatchCondition } from "./blocklist.ts";

export type SpamBlockScope = "address" | "domain" | "none";

export class SpamReportError extends Error {
  readonly status: 400 | 404;

  constructor(message: string, status: 400 | 404) {
    super(message);
    this.status = status;
  }
}

/**
 * Reports a Conversation as spam: archives it and, unless `block` is "none",
 * blocks its latest external sender's address or domain so future mail is
 * rejected. Other conversations from the newly blocked sender are archived
 * too. Reporting a sender that is already blocked reuses the existing rule.
 */
export async function reportSpam(
  env: { DB: D1Database },
  threadId: number,
  block: SpamBlockScope,
): Promise<SpamReportResult> {
  const thread = await env.DB.prepare("SELECT id FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: number }>();
  if (!thread) throw new SpamReportError("Conversation not found", 404);

  let rule: BlockedSender | null = null;
  if (block !== "none") {
    const sender = await env.DB.prepare(
      `SELECT lower(from_address) AS address FROM messages
       WHERE thread_id = ? AND direction = 'inbound' AND from_address LIKE '_%@_%'
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(threadId)
      .first<{ address: string }>();
    if (!sender) throw new SpamReportError("This conversation has no sender to block", 400);
    const pattern = block === "domain" ? domainOf(sender.address) : sender.address;
    rule = await addBlockedSender(env, pattern).catch(async (error) => {
      if (!(error instanceof BlockRuleError) || error.existingId === undefined) throw error;
      return env.DB.prepare("SELECT * FROM blocked_senders WHERE id = ?")
        .bind(error.existingId)
        .first<BlockedSender>();
    });
  }

  const match = rule ? senderMatchCondition(rule) : null;
  const result = await env.DB.prepare(
    `UPDATE threads SET status = 'archived', is_read = 1
     WHERE id = ?
        OR (${match ? "1" : "0"} AND status <> 'archived' AND id IN (
          SELECT msg.thread_id FROM messages msg
          WHERE msg.direction = 'inbound' AND ${match?.sql ?? "0"}
        ))`,
  )
    .bind(threadId, ...(match?.bindings ?? []))
    .run();
  return { blocked: rule, archived: Number(result.meta.changes ?? 0) };
}
