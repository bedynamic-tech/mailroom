import { Hono } from "hono";
import { z } from "zod";
import { MAX_RECIPIENTS_PER_MESSAGE } from "../../shared/email-limits.ts";
import { serializeReplyRecipients } from "../../shared/reply-recipients.ts";

type RecipientsEnv = { Bindings: { DB: D1Database } };

const addresses = z.array(z.email().max(254)).max(MAX_RECIPIENTS_PER_MESSAGE);
const replyRecipients = z
  .object({ to: addresses.nullable(), cc: addresses.nullable(), bcc: addresses })
  .refine(
    (value) => (value.to?.length ?? 0) + (value.cc?.length ?? 0) + value.bcc.length <= MAX_RECIPIENTS_PER_MESSAGE,
  );

/**
 * Saves the recipients edited in a Conversation's reply box, so the next
 * reply (on any device) starts with them. Nothing is sent from here.
 */
export const replyRecipientsApi = new Hono<RecipientsEnv>();

replyRecipientsApi.put("/:id/reply-recipients", async (c) => {
  const threadId = Number(c.req.param("id"));
  if (!Number.isSafeInteger(threadId) || threadId <= 0) {
    return c.json({ error: "Invalid conversation" }, 400);
  }
  const parsed = replyRecipients.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) {
    return c.json(
      { error: `Enter valid email addresses, up to ${MAX_RECIPIENTS_PER_MESSAGE} recipients` },
      400,
    );
  }
  const result = await c.env.DB.prepare("UPDATE threads SET reply_recipients = ? WHERE id = ?")
    .bind(serializeReplyRecipients(parsed.data), threadId)
    .run();
  if (!result.meta.changes) return c.json({ error: "Conversation not found" }, 404);
  return c.json({ ok: true });
});
