import { Hono } from "hono";
import { addBlockedSender, BlockRuleError } from "../spam/blocklist.ts";
import type { BlockedSender } from "../../shared/types.ts";

export const blockedSendersApi = new Hono<{ Bindings: { DB: D1Database } }>();

blockedSendersApi.get("/", async (c) => {
  const { results } = await c.env.DB.prepare(
    "SELECT * FROM blocked_senders ORDER BY created_at DESC, id DESC",
  ).all<BlockedSender>();
  return c.json(results);
});

blockedSendersApi.post("/", async (c) => {
  const body = await c.req.json<{ pattern?: unknown }>().catch(() => null);
  try {
    return c.json(await addBlockedSender(c.env, body?.pattern), 201);
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
