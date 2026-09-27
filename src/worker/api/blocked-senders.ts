import { Hono } from "hono";
import { addBlockedSender, BLOCKED_SENDER_COLUMNS, BlockRuleError } from "../spam/blocklist.ts";
import type { BlockedSender } from "../../shared/types.ts";

export const blockedSendersApi = new Hono<{ Bindings: { DB: D1Database } }>();

blockedSendersApi.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT ${BLOCKED_SENDER_COLUMNS} ORDER BY b.created_at DESC, b.id DESC`,
  ).all<BlockedSender>();
  return c.json(results);
});

blockedSendersApi.post("/", async (c) => {
  const body = await c.req.json<{ pattern?: unknown; mailbox_id?: unknown }>().catch(() => null);
  const mailboxId = body?.mailbox_id ?? null;
  if (mailboxId !== null && (typeof mailboxId !== "number" || !Number.isSafeInteger(mailboxId))) {
    return c.json({ error: "Choose an inbox, or all inboxes" }, 400);
  }
  try {
    return c.json(await addBlockedSender(c.env, body?.pattern, mailboxId), 201);
  } catch (error) {
    if (error instanceof BlockRuleError) {
      return c.json({ error: error.message, id: error.existingId }, error.status);
    }
    throw error;
  }
});

blockedSendersApi.delete("/:id", async (c) => {
  const id = c.req.param("id");
  if (!/^\d+$/.test(id)) return c.json({ error: "invalid blocked sender id" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM blocked_senders WHERE id = ?")
    .bind(Number(id))
    .run();
  if (!result.meta.changes) return c.json({ error: "Blocked sender not found" }, 404);
  return c.json({ ok: true });
});
