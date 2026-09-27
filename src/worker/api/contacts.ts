import { Hono } from "hono";
import {
  normalizeContactAddress,
  parseContactFields,
} from "../contacts/contacts.ts";
import type { Contact, ContactConversation, ContactDetail } from "../../shared/types.ts";

export const CONTACT_PAGE_SIZE = 100;
const CONTACT_CONVERSATION_LIMIT = 20;

export const contactsApi = new Hono<{ Bindings: { DB: D1Database } }>();

contactsApi.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const beforeAt = c.req.query("before_at") ?? "";
  const beforeId = parseId(c.req.query("before_id") ?? "") ?? 0;
  const limit = Math.min(parseId(c.req.query("limit") ?? "") ?? CONTACT_PAGE_SIZE, CONTACT_PAGE_SIZE);
  const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM contacts
     WHERE (?1 = '' OR address LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\'
            OR company LIKE ?2 ESCAPE '\\')
       AND (?3 = '' OR COALESCE(last_seen_at, created_at) < ?3
            OR (COALESCE(last_seen_at, created_at) = ?3 AND id < ?4))
     ORDER BY COALESCE(last_seen_at, created_at) DESC, id DESC
     LIMIT ?5`,
  )
    .bind(q, pattern, beforeAt, beforeId, limit)
    .all<Contact>();
  return c.json(results);
});

contactsApi.get("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid contact id" }, 400);
  const contact = await c.env.DB.prepare("SELECT * FROM contacts WHERE id = ?")
    .bind(id)
    .first<Contact>();
  if (!contact) return c.json({ error: "Contact not found" }, 404);

  const fromContact = `SELECT DISTINCT msg.thread_id FROM messages msg
     WHERE msg.from_address = ?1 COLLATE NOCASE AND msg.direction = 'inbound'`;
  const [conversations, count] = await Promise.all([
    c.env.DB.prepare(
      `SELECT t.id, t.mailbox_id, m.address AS mailbox_address, t.subject, t.status,
              t.last_message_at
       FROM threads t
       JOIN mailboxes m ON m.id = t.mailbox_id
       WHERE t.id IN (${fromContact})
       ORDER BY t.last_message_at DESC, t.id DESC
       LIMIT ${CONTACT_CONVERSATION_LIMIT}`,
    )
      .bind(contact.address)
      .all<ContactConversation>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM (${fromContact})`)
      .bind(contact.address)
      .first<{ count: number }>(),
  ]);
  const detail: ContactDetail = {
    contact,
    conversation_count: Number(count?.count ?? 0),
    conversations: conversations.results,
  };
  return c.json(detail);
});

contactsApi.post("/", async (c) => {
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: "Send the contact as JSON" }, 400);
  const address = normalizeContactAddress(body.address);
  if (!address) return c.json({ error: "Enter a valid email address" }, 400);
  const parsed = parseContactFields(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);

  const inbox = await c.env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?")
    .bind(address)
    .first();
  if (inbox) return c.json({ error: "That address is one of this workspace's inboxes" }, 400);

  const existing = await c.env.DB.prepare("SELECT id FROM contacts WHERE address = ?")
    .bind(address)
    .first<{ id: number }>();
  if (existing) {
    return c.json({ error: "A contact with this address already exists", id: existing.id }, 409);
  }

  const { name = null, company = null, phone = null, notes = null } = parsed.fields;
  const contact = await c.env.DB.prepare(
    `INSERT INTO contacts (address, name, company, phone, notes, last_seen_at)
     VALUES (?1, ?2, ?3, ?4, ?5, (
       SELECT MAX(created_at) FROM messages
       WHERE from_address = ?1 COLLATE NOCASE AND direction = 'inbound'
     ))
     RETURNING *`,
  )
    .bind(address, name, company, phone, notes)
    .first<Contact>();
  return c.json(contact, 201);
});

contactsApi.patch("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid contact id" }, 400);
  const body = await readBody(c.req.raw);
  if (!body) return c.json({ error: "Send the contact as JSON" }, 400);
  if (body.address !== undefined) {
    return c.json({ error: "A contact's address can't be changed" }, 400);
  }
  const parsed = parseContactFields(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const entries = Object.entries(parsed.fields);
  if (entries.length === 0) return c.json({ error: "no fields to update" }, 400);

  const contact = await c.env.DB.prepare(
    `UPDATE contacts
     SET ${entries.map(([field]) => `${field} = ?`).join(", ")},
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ? RETURNING *`,
  )
    .bind(...entries.map(([, value]) => value), id)
    .first<Contact>();
  if (!contact) return c.json({ error: "Contact not found" }, 404);
  return c.json(contact);
});

contactsApi.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid contact id" }, 400);
  const result = await c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(id).run();
  if (!result.meta.changes) return c.json({ error: "Contact not found" }, 404);
  return c.json({ ok: true });
});

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
