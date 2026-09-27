import { Hono } from "hono";
import {
  normalizeContactAddress,
  parseContactFields,
  type ContactFields,
} from "../contacts/contacts.ts";
import { MAX_CONTACT_IMPORT_BATCH } from "../../shared/contacts.ts";
import type {
  Contact,
  ContactConversation,
  ContactDetail,
  ContactImportResult,
} from "../../shared/types.ts";

export const CONTACT_PAGE_SIZE = 100;
const CONTACT_CONVERSATION_LIMIT = 20;

export const contactsApi = new Hono<{ Bindings: { DB: D1Database } }>();

// A contact sorts by its name, or by its address when it has no name.
const contactSortKey = (name: string, address: string) =>
  `lower(COALESCE(NULLIF(trim(${name}), ''), ${address}))`;

contactsApi.get("/", async (c) => {
  const q = (c.req.query("q") ?? "").trim().slice(0, 200);
  const limit = Math.min(parseId(c.req.query("limit") ?? "") ?? CONTACT_PAGE_SIZE, CONTACT_PAGE_SIZE);
  const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;

  if (c.req.query("sort") === "name") {
    // Keyset pagination: the cursor is the last row's name, address and id.
    const afterAddress = c.req.query("after_address") ?? "";
    const afterName = c.req.query("after_name") ?? "";
    const afterId = parseId(c.req.query("after_id") ?? "") ?? 0;
    const key = contactSortKey("name", "address");
    const cursorKey = contactSortKey("?4", "?3");
    const { results } = await c.env.DB.prepare(
      `SELECT * FROM contacts
       WHERE (?1 = '' OR address LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\'
              OR company LIKE ?2 ESCAPE '\\')
         AND (?3 = '' OR ${key} > ${cursorKey} OR (${key} = ${cursorKey} AND id > ?5))
       ORDER BY ${key} ASC, id ASC
       LIMIT ?6`,
    )
      .bind(q, pattern, afterAddress, afterName, afterId, limit)
      .all<Contact>();
    return c.json(results);
  }

  const beforeAt = c.req.query("before_at") ?? "";
  const beforeId = parseId(c.req.query("before_id") ?? "") ?? 0;
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

/**
 * Adds or updates many Contacts at once. New addresses become Contacts;
 * for existing ones, imported details fill empty fields, or replace them
 * when `overwrite` is set. Blank imported values never clear a field.
 */
contactsApi.post("/import", async (c) => {
  const body = await readBody(c.req.raw);
  const entries = body?.contacts;
  if (!Array.isArray(entries) || entries.length === 0) {
    return c.json({ error: "Send the contacts to import" }, 400);
  }
  if (entries.length > MAX_CONTACT_IMPORT_BATCH) {
    return c.json({ error: `Import at most ${MAX_CONTACT_IMPORT_BATCH} contacts per request` }, 400);
  }
  const overwrite = body?.overwrite === true ? 1 : 0;

  const { results: inboxes } = await c.env.DB.prepare("SELECT address FROM mailboxes")
    .all<{ address: string }>();
  const inboxAddresses = new Set(inboxes.map((inbox) => inbox.address.toLowerCase()));

  const result: ContactImportResult = { created: 0, updated: 0, skipped: 0, errors: [] };
  const rows = new Map<string, ReturnType<typeof importRow>>();
  const skip = (address: string, error: string) => {
    result.skipped++;
    if (result.errors.length < 20) result.errors.push({ address, error });
  };
  for (const entry of entries) {
    const record = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    const address = normalizeContactAddress(record.address);
    const label = typeof record.address === "string" ? record.address.slice(0, 254) : "";
    if (!address) skip(label, "Not a valid email address");
    else if (inboxAddresses.has(address)) skip(address, "One of this workspace's inboxes");
    else if (rows.has(address)) skip(address, "Listed more than once");
    else {
      const parsed = parseContactFields(record);
      if ("error" in parsed) skip(address, parsed.error);
      else rows.set(address, importRow(address, parsed.fields));
    }
  }

  const addresses = [...rows.keys()];
  for (let i = 0; i < addresses.length; i += 90) {
    const chunk = addresses.slice(i, i + 90);
    const existing = await c.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM contacts WHERE address IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .first<{ count: number }>();
    result.updated += Number(existing?.count ?? 0);
  }
  result.created = addresses.length - result.updated;

  const statements = [...rows.values()].map((row) =>
    c.env.DB.prepare(
      `INSERT INTO contacts (address, name, company, phone, notes, last_seen_at)
       VALUES (?1, ?2, ?3, ?4, ?5, (
         SELECT MAX(created_at) FROM messages
         WHERE from_address = ?1 COLLATE NOCASE AND direction = 'inbound'
       ))
       ON CONFLICT(address) DO UPDATE SET
         name = CASE WHEN ?6 THEN COALESCE(excluded.name, name) ELSE COALESCE(name, excluded.name) END,
         company = CASE WHEN ?6 THEN COALESCE(excluded.company, company) ELSE COALESCE(company, excluded.company) END,
         phone = CASE WHEN ?6 THEN COALESCE(excluded.phone, phone) ELSE COALESCE(phone, excluded.phone) END,
         notes = CASE WHEN ?6 THEN COALESCE(excluded.notes, notes) ELSE COALESCE(notes, excluded.notes) END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
    ).bind(...row, overwrite),
  );
  for (let i = 0; i < statements.length; i += 100) {
    await c.env.DB.batch(statements.slice(i, i + 100));
  }
  return c.json(result);
});

function importRow(address: string, fields: ContactFields) {
  return [
    address,
    fields.name ?? null,
    fields.company ?? null,
    fields.phone ?? null,
    fields.notes ?? null,
  ] as const;
}

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
