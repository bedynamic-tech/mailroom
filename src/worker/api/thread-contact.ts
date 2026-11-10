import { Hono } from "hono";
import { z } from "zod";
import {
  parseReplyRecipients,
  serializeReplyRecipients,
} from "../../shared/reply-recipients.ts";

type ContactEnv = { Bindings: { DB: D1Database } };

const MAX_NAME_LENGTH = 200;

const contactInput = z.object({
  address: z.email().max(254),
  name: z.string().max(MAX_NAME_LENGTH).nullish(),
});

/**
 * Changes who a Conversation is with, for when it arrived from the wrong
 * address, such as an email the user forwarded in from their own mailbox.
 * The received Messages from the current sender are rewritten to the new
 * one, so the list, replies, the agent, contacts and blocking all follow
 * it. The sender as received is kept on each Message, so it can be shown
 * and restored.
 */
export const threadContactApi = new Hono<ContactEnv>();

threadContactApi.put("/:id/contact", async (c) => {
  const threadId = parseId(c.req.param("id"));
  if (threadId === null) return c.json({ error: "Invalid conversation" }, 400);
  const parsed = contactInput.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: "Enter a valid email address" }, 400);
  const address = parsed.data.address.trim().toLowerCase();
  const name = parsed.data.name?.trim() || null;

  const thread = await c.env.DB.prepare("SELECT id, reply_recipients FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: number; reply_recipients: string | null }>();
  if (!thread) return c.json({ error: "Conversation not found" }, 404);
  const ownAddress = await c.env.DB.prepare("SELECT id FROM mailboxes WHERE address = ? COLLATE NOCASE")
    .bind(address)
    .first();
  if (ownAddress) return c.json({ error: "Choose someone other than one of your inboxes" }, 400);

  const current = await c.env.DB.prepare(
    `SELECT from_address FROM messages
     WHERE thread_id = ? AND direction = 'inbound'
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(threadId)
    .first<{ from_address: string }>();
  if (!current) {
    return c.json({ error: "This conversation has no received email to reassign" }, 409);
  }

  // SQLite reads every right-hand side from the row as it was, so the
  // original columns capture the sender before this change, once.
  const [updated] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE messages SET
         original_from_name = CASE WHEN original_from_address IS NULL THEN from_name ELSE original_from_name END,
         original_reply_to_addresses = CASE WHEN original_from_address IS NULL
           THEN reply_to_addresses ELSE original_reply_to_addresses END,
         original_from_address = COALESCE(original_from_address, from_address),
         from_address = ?, from_name = ?, reply_to_addresses = '[]'
       WHERE thread_id = ? AND direction = 'inbound' AND from_address = ? COLLATE NOCASE`,
    ).bind(address, name, threadId, current.from_address),
    followNewSender(c.env.DB, threadId, thread.reply_recipients),
  ]);
  return c.json({ ok: true, updated: updated.meta.changes ?? 0 });
});

threadContactApi.delete("/:id/contact", async (c) => {
  const threadId = parseId(c.req.param("id"));
  if (threadId === null) return c.json({ error: "Invalid conversation" }, 400);
  const thread = await c.env.DB.prepare("SELECT id, reply_recipients FROM threads WHERE id = ?")
    .bind(threadId)
    .first<{ id: number; reply_recipients: string | null }>();
  if (!thread) return c.json({ error: "Conversation not found" }, 404);
  const [restored] = await c.env.DB.batch([
    c.env.DB.prepare(
      `UPDATE messages SET
         from_address = original_from_address,
         from_name = original_from_name,
         reply_to_addresses = COALESCE(original_reply_to_addresses, '[]'),
         original_from_address = NULL, original_from_name = NULL, original_reply_to_addresses = NULL
       WHERE thread_id = ? AND original_from_address IS NOT NULL`,
    ).bind(threadId),
    followNewSender(c.env.DB, threadId, thread.reply_recipients),
  ]);
  return c.json({ ok: true, updated: restored.meta.changes ?? 0 });
});

/** Drops an edited reply To, so the reply box addresses whoever the Conversation is now with. */
function followNewSender(db: D1Database, threadId: number, raw: string | null) {
  const recipients = parseReplyRecipients(raw);
  return db
    .prepare("UPDATE threads SET reply_recipients = ? WHERE id = ?")
    .bind(serializeReplyRecipients({ ...recipients, to: null }), threadId);
}

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
