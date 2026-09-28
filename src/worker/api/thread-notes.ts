import { Hono } from "hono";
import { MAX_RICH_TEXT_HTML_LENGTH, normalizeMessageBody } from "../../shared/rich-text.ts";
import type { ThreadNote } from "../../shared/types.ts";

type NotesEnv = { Bindings: { DB: D1Database } };

/** Longest plain-text Internal Note accepted. */
export const MAX_THREAD_NOTE_LENGTH = 20_000;

/**
 * Internal Notes on a Conversation. They are stored apart from messages and
 * only ever returned to the web app, so nothing that sends, quotes, forwards,
 * drafts or notifies can include them.
 */
export const threadNotesApi = new Hono<NotesEnv>();

threadNotesApi.post("/:id/notes", async (c) => {
  const threadId = parseId(c.req.param("id"));
  if (threadId === null) return c.json({ error: "Invalid conversation" }, 400);
  const body = await c.req.json<{ text?: unknown; html?: unknown }>().catch(() => null);
  const text = typeof body?.text === "string" ? body.text : "";
  const html = typeof body?.html === "string" ? body.html : "";
  if (html.length > MAX_RICH_TEXT_HTML_LENGTH) return c.json({ error: "Note is too long" }, 400);
  const note = normalizeMessageBody(text, html || null);
  if (!note.text) return c.json({ error: "Write a note" }, 400);
  if (note.text.length > MAX_THREAD_NOTE_LENGTH) return c.json({ error: "Note is too long" }, 400);

  const thread = await c.env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first();
  if (!thread) return c.json({ error: "Conversation not found" }, 404);
  const saved = await c.env.DB.prepare(
    `INSERT INTO thread_notes (thread_id, text_body, html_body) VALUES (?, ?, ?)
     RETURNING id, thread_id, text_body, html_body, mail_rule_id, NULL AS mail_rule_name, created_at`,
  )
    .bind(threadId, note.text, note.html)
    .first<ThreadNote>();
  return c.json(saved, 201);
});

threadNotesApi.delete("/:id/notes/:noteId", async (c) => {
  const threadId = parseId(c.req.param("id"));
  const noteId = parseId(c.req.param("noteId"));
  if (threadId === null || noteId === null) return c.json({ error: "Invalid note" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM thread_notes WHERE id = ? AND thread_id = ?")
    .bind(noteId, threadId)
    .run();
  if (!result.meta.changes) return c.json({ error: "Note not found" }, 404);
  return c.json({ ok: true });
});

/** Internal Notes on one Conversation, oldest first. */
export async function listThreadNotes(db: D1Database, threadId: number): Promise<ThreadNote[]> {
  const { results } = await db
    .prepare(
      `SELECT n.id, n.thread_id, n.text_body, n.html_body, n.mail_rule_id, r.name AS mail_rule_name, n.created_at
       FROM thread_notes n LEFT JOIN mail_rules r ON r.id = n.mail_rule_id
       WHERE n.thread_id = ? ORDER BY n.created_at, n.id`,
    )
    .bind(threadId)
    .all<ThreadNote>();
  return results;
}

function parseId(value: string): number | null {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
