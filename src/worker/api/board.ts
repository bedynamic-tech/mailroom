import { Hono } from "hono";
import {
  MAX_BOARD_CARD_CONVERSATIONS,
  MAX_BOARD_CARD_DESCRIPTION_LENGTH,
  MAX_BOARD_CARD_TITLE_LENGTH,
  MAX_BOARD_COLUMN_NAME_LENGTH,
  MAX_BOARD_COLUMNS,
  MAX_BOARD_NOTE_LENGTH,
} from "../../shared/board.ts";
import type {
  Board,
  BoardCard,
  BoardCardConversation,
  BoardCardDetail,
  BoardCardNote,
  BoardColumn,
  RelatedConversation,
} from "../../shared/types.ts";

type BoardEnv = { Bindings: { DB: D1Database } };

export const boardApi = new Hono<BoardEnv>();

const MAX_SUGGESTIONS = 5;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";

boardApi.get("/", async (c) => c.json(await loadBoard(c.env.DB)));

boardApi.post("/columns", async (c) => {
  const body = await readBody(c.req.raw);
  const name = columnName(body?.name);
  if ("error" in name) return c.json({ error: name.error }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM board_columns")
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) >= MAX_BOARD_COLUMNS) {
    return c.json({ error: `A board can have at most ${MAX_BOARD_COLUMNS} columns` }, 400);
  }
  const column = await c.env.DB.prepare(
    `INSERT INTO board_columns (name, position)
     VALUES (?, (SELECT COALESCE(MAX(position) + 1, 0) FROM board_columns))
     RETURNING id, name, position`,
  )
    .bind(name.value)
    .first<BoardColumn>();
  return c.json(column, 201);
});

/** Sets the left-to-right order of every Column at once. */
boardApi.put("/columns/order", async (c) => {
  const body = await readBody(c.req.raw);
  const ids = idList(body?.ids);
  if (!ids) return c.json({ error: "Send the column ids in their new order" }, 400);
  const { results } = await c.env.DB.prepare("SELECT id FROM board_columns").all<{ id: number }>();
  const existing = new Set(results.map((row) => row.id));
  if (ids.length !== existing.size || ids.some((id) => !existing.has(id))) {
    return c.json({ error: "The board's columns changed. Reload and try again." }, 409);
  }
  await c.env.DB.prepare(
    `UPDATE board_columns
     SET position = (SELECT CAST(key AS INTEGER) FROM json_each(?1) WHERE value = board_columns.id)
     WHERE id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(ids))
    .run();
  return c.json(await loadBoard(c.env.DB));
});

boardApi.patch("/columns/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid column id" }, 400);
  const body = await readBody(c.req.raw);
  const name = columnName(body?.name);
  if ("error" in name) return c.json({ error: name.error }, 400);
  const column = await c.env.DB.prepare(
    "UPDATE board_columns SET name = ? WHERE id = ? RETURNING id, name, position",
  )
    .bind(name.value, id)
    .first<BoardColumn>();
  if (!column) return c.json({ error: "Column not found" }, 404);
  return c.json(column);
});

/** Deletes a Column with its Cards. The linked Conversations are kept. */
boardApi.delete("/columns/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid column id" }, 400);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS count FROM board_columns")
    .first<{ count: number }>();
  if (Number(count?.count ?? 0) <= 1) {
    return c.json({ error: "A board needs at least one column" }, 400);
  }
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `DELETE FROM board_card_threads
       WHERE card_id IN (SELECT id FROM board_cards WHERE column_id = ?)`,
    ).bind(id),
    c.env.DB.prepare(
      `DELETE FROM board_card_notes
       WHERE card_id IN (SELECT id FROM board_cards WHERE column_id = ?)`,
    ).bind(id),
    c.env.DB.prepare("DELETE FROM board_cards WHERE column_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM board_columns WHERE id = ?").bind(id),
  ]);
  if (!results[3].meta.changes) return c.json({ error: "Column not found" }, 404);
  return c.json({ ok: true });
});

boardApi.post("/cards", async (c) => {
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: "Send the card as JSON" }, 400);
  const fields = cardFields(body, true);
  if ("error" in fields) return c.json({ error: fields.error }, 400);

  let threadIds: number[] = [];
  if (body.thread_ids !== undefined) {
    const ids = idList(body.thread_ids, true);
    if (!ids) return c.json({ error: "thread_ids must be a list of conversation ids" }, 400);
    if (ids.length > MAX_BOARD_CARD_CONVERSATIONS) {
      return c.json({ error: `A card can link at most ${MAX_BOARD_CARD_CONVERSATIONS} conversations` }, 400);
    }
    threadIds = [...new Set(ids)];
    const missing = await missingThreads(c.env.DB, threadIds);
    if (missing) return c.json({ error: "Conversation not found" }, 404);
  }

  let columnId: number | null = null;
  if (body.column_id !== undefined) {
    columnId = typeof body.column_id === "number" ? parseId(String(body.column_id)) : null;
    if (columnId === null) return c.json({ error: "invalid column id" }, 400);
  }
  const column = await c.env.DB.prepare(
    columnId === null
      ? "SELECT id FROM board_columns ORDER BY position, id LIMIT 1"
      : "SELECT id FROM board_columns WHERE id = ?",
  )
    .bind(...(columnId === null ? [] : [columnId]))
    .first<{ id: number }>();
  if (!column) return c.json({ error: "Column not found" }, 404);

  const card = await c.env.DB.prepare(
    `INSERT INTO board_cards (column_id, title, description, position)
     VALUES (?1, ?2, ?3, (SELECT COALESCE(MAX(position) + 1, 0) FROM board_cards WHERE column_id = ?1))
     RETURNING id`,
  )
    .bind(column.id, fields.title, fields.description ?? null)
    .first<{ id: number }>();
  if (!card) throw new Error("Card was not created");
  if (threadIds.length) {
    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO board_card_threads (card_id, thread_id)
       SELECT ?, value FROM json_each(?)`,
    )
      .bind(card.id, JSON.stringify(threadIds))
      .run();
  }
  return c.json(await loadCard(c.env.DB, card.id), 201);
});

boardApi.get("/cards/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const [card, notes] = await Promise.all([
    loadCard(c.env.DB, id),
    c.env.DB.prepare(
      "SELECT id, card_id, body, created_at FROM board_card_notes WHERE card_id = ? ORDER BY created_at, id",
    )
      .bind(id)
      .all<BoardCardNote>(),
  ]);
  if (!card) return c.json({ error: "Card not found" }, 404);
  const detail: BoardCardDetail = { ...card, notes: notes.results };
  return c.json(detail);
});

boardApi.post("/cards/:id/notes", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const body = await readBody(c.req.raw);
  const text = typeof body?.body === "string" ? body.body.replace(/\r\n?/g, "\n").trim() : "";
  if (!text) return c.json({ error: "Write a note" }, 400);
  if (text.length > MAX_BOARD_NOTE_LENGTH) return c.json({ error: "Note is too long" }, 400);
  const card = await c.env.DB.prepare("SELECT id FROM board_cards WHERE id = ?").bind(id).first();
  if (!card) return c.json({ error: "Card not found" }, 404);
  const note = await c.env.DB.prepare(
    "INSERT INTO board_card_notes (card_id, body) VALUES (?, ?) RETURNING id, card_id, body, created_at",
  )
    .bind(id, text)
    .first<BoardCardNote>();
  await c.env.DB.prepare(`UPDATE board_cards SET updated_at = ${NOW} WHERE id = ?`).bind(id).run();
  return c.json(note, 201);
});

boardApi.delete("/cards/:id/notes/:noteId", async (c) => {
  const id = parseId(c.req.param("id"));
  const noteId = parseId(c.req.param("noteId"));
  if (id === null || noteId === null) return c.json({ error: "invalid id" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM board_card_notes WHERE id = ? AND card_id = ?")
    .bind(noteId, id)
    .run();
  if (!result.meta.changes) return c.json({ error: "Note not found" }, 404);
  return c.json({ ok: true });
});

boardApi.patch("/cards/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: "Send the card as JSON" }, 400);
  if (body.column_id !== undefined) {
    return c.json({ error: "Move a card with its move endpoint" }, 400);
  }
  const fields = cardFields(body, false);
  if ("error" in fields) return c.json({ error: fields.error }, 400);
  const entries = Object.entries(fields);
  if (entries.length === 0) return c.json({ error: "no fields to update" }, 400);
  const updated = await c.env.DB.prepare(
    `UPDATE board_cards
     SET ${entries.map(([field]) => `${field} = ?`).join(", ")}, updated_at = ${NOW}
     WHERE id = ? RETURNING id`,
  )
    .bind(...entries.map(([, value]) => value), id)
    .first<{ id: number }>();
  if (!updated) return c.json({ error: "Card not found" }, 404);
  return c.json(await loadCard(c.env.DB, id));
});

/** Moves a Card to a position (0 = top) in a Column, renumbering that Column. */
boardApi.post("/cards/:id/move", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const body = await readBody(c.req.raw);
  const columnId = typeof body?.column_id === "number" ? parseId(String(body.column_id)) : null;
  const index = body?.index;
  if (columnId === null) return c.json({ error: "invalid column id" }, 400);
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0) {
    return c.json({ error: "index must be a position in the column" }, 400);
  }
  const [card, column] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM board_cards WHERE id = ?").bind(id).first(),
    c.env.DB.prepare("SELECT id FROM board_columns WHERE id = ?").bind(columnId).first(),
  ]);
  if (!card) return c.json({ error: "Card not found" }, 404);
  if (!column) return c.json({ error: "Column not found" }, 404);

  const { results } = await c.env.DB.prepare(
    "SELECT id FROM board_cards WHERE column_id = ? AND id <> ? ORDER BY position, id",
  )
    .bind(columnId, id)
    .all<{ id: number }>();
  const order = results.map((row) => row.id);
  order.splice(Math.min(index, order.length), 0, id);
  await c.env.DB.prepare(
    `UPDATE board_cards
     SET column_id = ?2,
         position = (SELECT CAST(key AS INTEGER) FROM json_each(?1) WHERE value = board_cards.id),
         updated_at = CASE WHEN id = ?3 THEN ${NOW} ELSE updated_at END
     WHERE id IN (SELECT value FROM json_each(?1))`,
  )
    .bind(JSON.stringify(order), columnId, id)
    .run();
  return c.json(await loadBoard(c.env.DB));
});

boardApi.delete("/cards/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const results = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM board_card_threads WHERE card_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM board_card_notes WHERE card_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM board_cards WHERE id = ?").bind(id),
  ]);
  if (!results[2].meta.changes) return c.json({ error: "Card not found" }, 404);
  return c.json({ ok: true });
});

boardApi.post("/cards/:id/conversations", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const body = await readBody(c.req.raw);
  const threadId = typeof body?.thread_id === "number" ? parseId(String(body.thread_id)) : null;
  if (threadId === null) return c.json({ error: "invalid conversation id" }, 400);
  const [card, thread, count] = await Promise.all([
    c.env.DB.prepare("SELECT id FROM board_cards WHERE id = ?").bind(id).first(),
    c.env.DB.prepare("SELECT id FROM threads WHERE id = ?").bind(threadId).first(),
    c.env.DB.prepare("SELECT COUNT(*) AS count FROM board_card_threads WHERE card_id = ?")
      .bind(id)
      .first<{ count: number }>(),
  ]);
  if (!card) return c.json({ error: "Card not found" }, 404);
  if (!thread) return c.json({ error: "Conversation not found" }, 404);
  if (Number(count?.count ?? 0) >= MAX_BOARD_CARD_CONVERSATIONS) {
    return c.json({ error: `A card can link at most ${MAX_BOARD_CARD_CONVERSATIONS} conversations` }, 400);
  }
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT OR IGNORE INTO board_card_threads (card_id, thread_id) VALUES (?, ?)",
    ).bind(id, threadId),
    c.env.DB.prepare(`UPDATE board_cards SET updated_at = ${NOW} WHERE id = ?`).bind(id),
  ]);
  return c.json(await loadCard(c.env.DB, id));
});

/**
 * Recent Conversations from the senders of the Card's linked Conversations
 * that the Card doesn't link yet, such as a follow-up email that opened a
 * new Conversation.
 */
boardApi.get("/cards/:id/suggestions", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid card id" }, 400);
  const { results } = await c.env.DB.prepare(
    `SELECT t.id, t.subject, t.status, m.address AS mailbox_address, t.last_message_at,
       (SELECT COALESCE(li.from_name, li.from_address) FROM messages li
        WHERE li.thread_id = t.id AND li.direction = 'inbound'
        ORDER BY li.created_at DESC, li.id DESC LIMIT 1) AS last_from
     FROM threads t
     JOIN mailboxes m ON m.id = t.mailbox_id
     WHERE t.id NOT IN (SELECT thread_id FROM board_card_threads WHERE card_id = ?1)
       AND t.id IN (
         SELECT msg.thread_id FROM messages msg
         WHERE msg.direction = 'inbound'
           AND msg.from_address COLLATE NOCASE IN (
             SELECT src.from_address FROM messages src
             JOIN board_card_threads link ON link.thread_id = src.thread_id
             WHERE link.card_id = ?1 AND src.direction = 'inbound'
           )
       )
     ORDER BY t.last_message_at DESC, t.id DESC
     LIMIT ${MAX_SUGGESTIONS}`,
  )
    .bind(id)
    .all<RelatedConversation>();
  return c.json(results);
});

boardApi.delete("/cards/:id/conversations/:threadId", async (c) => {
  const id = parseId(c.req.param("id"));
  const threadId = parseId(c.req.param("threadId"));
  if (id === null || threadId === null) return c.json({ error: "invalid id" }, 400);
  const result = await c.env.DB.prepare(
    "DELETE FROM board_card_threads WHERE card_id = ? AND thread_id = ?",
  )
    .bind(id, threadId)
    .run();
  if (!result.meta.changes) return c.json({ error: "Link not found" }, 404);
  return c.json(await loadCard(c.env.DB, id));
});

async function loadBoard(db: D1Database): Promise<Board> {
  const [columns, cards, links] = await Promise.all([
    db.prepare("SELECT id, name, position FROM board_columns ORDER BY position, id")
      .all<BoardColumn>(),
    db.prepare(
      `SELECT id, column_id, title, description, position, created_at, updated_at,
         (SELECT COUNT(*) FROM board_card_notes n WHERE n.card_id = board_cards.id) AS note_count
       FROM board_cards ORDER BY position, id`,
    ).all<Omit<BoardCard, "conversations">>(),
    db.prepare(`${LINK_SELECT} ORDER BY bct.created_at, t.id`).all<LinkRow>(),
  ]);
  return {
    columns: columns.results,
    cards: withConversations(cards.results, links.results),
  };
}

async function loadCard(db: D1Database, id: number): Promise<BoardCard | null> {
  const [card, links] = await Promise.all([
    db.prepare(
      `SELECT id, column_id, title, description, position, created_at, updated_at,
         (SELECT COUNT(*) FROM board_card_notes n WHERE n.card_id = board_cards.id) AS note_count
       FROM board_cards WHERE id = ?`,
    )
      .bind(id)
      .first<Omit<BoardCard, "conversations">>(),
    db.prepare(`${LINK_SELECT} WHERE bct.card_id = ? ORDER BY bct.created_at, t.id`)
      .bind(id)
      .all<LinkRow>(),
  ]);
  return card ? withConversations([card], links.results)[0] : null;
}

type LinkRow = BoardCardConversation & { card_id: number };

const LINK_SELECT = `SELECT bct.card_id, t.id, t.subject, t.status, m.address AS mailbox_address
  FROM board_card_threads bct
  JOIN threads t ON t.id = bct.thread_id
  JOIN mailboxes m ON m.id = t.mailbox_id`;

function withConversations(
  cards: Omit<BoardCard, "conversations">[],
  links: LinkRow[],
): BoardCard[] {
  const byCard = new Map<number, BoardCardConversation[]>();
  for (const { card_id, ...conversation } of links) {
    const list = byCard.get(card_id) ?? [];
    list.push(conversation);
    byCard.set(card_id, list);
  }
  return cards.map((card) => ({ ...card, conversations: byCard.get(card.id) ?? [] }));
}

async function missingThreads(db: D1Database, ids: number[]): Promise<boolean> {
  const found = await db.prepare(
    "SELECT COUNT(*) AS count FROM threads WHERE id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(ids))
    .first<{ count: number }>();
  return Number(found?.count ?? 0) !== ids.length;
}

function columnName(value: unknown): { value: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "Enter a column name" };
  const name = value.trim().replace(/\s+/g, " ");
  if (name.length > MAX_BOARD_COLUMN_NAME_LENGTH) return { error: "Column name is too long" };
  return { value: name };
}

function cardFields(
  body: Record<string, unknown>,
  requireTitle: boolean,
): { title?: string; description?: string | null } | { error: string } {
  const fields: { title?: string; description?: string | null } = {};
  if (body.title !== undefined || requireTitle) {
    if (typeof body.title !== "string" || !body.title.trim()) return { error: "Enter a title" };
    const title = body.title.trim().replace(/\s+/g, " ");
    if (title.length > MAX_BOARD_CARD_TITLE_LENGTH) return { error: "Title is too long" };
    fields.title = title;
  }
  if (body.description !== undefined) {
    if (body.description !== null && typeof body.description !== "string") {
      return { error: "Description must be text" };
    }
    const description = (body.description ?? "").replace(/\r\n?/g, "\n").trim();
    if (description.length > MAX_BOARD_CARD_DESCRIPTION_LENGTH) {
      return { error: "Description is too long" };
    }
    fields.description = description || null;
  }
  return fields;
}

function idList(value: unknown, allowEmpty = false): number[] | null {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 100) {
    return null;
  }
  const ids = value.map((item) => (typeof item === "number" ? parseId(String(item)) : null));
  return ids.every((id): id is number => id !== null) ? ids : null;
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null;
}

function parseId(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
