import { Hono } from "hono";
import {
  normalizeContactAddress,
  parseContactAddresses,
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

// A search pattern (?2) matches any of a contact's addresses, its name or its company.
const MATCHES_SEARCH = `address LIKE ?2 ESCAPE '\\' OR name LIKE ?2 ESCAPE '\\'
  OR company LIKE ?2 ESCAPE '\\'
  OR id IN (SELECT contact_id FROM contact_addresses WHERE address LIKE ?2 ESCAPE '\\')`;

// Every address of the contact with id ?2 and primary address ?1.
const CONTACT_ADDRESSES = `SELECT ?1 UNION SELECT address FROM contact_addresses WHERE contact_id = ?2`;

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
       WHERE (?1 = '' OR ${MATCHES_SEARCH})
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
     WHERE (?1 = '' OR ${MATCHES_SEARCH})
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
     WHERE msg.from_address COLLATE NOCASE IN (${CONTACT_ADDRESSES})
       AND msg.direction = 'inbound'`;
  const [addresses, conversations, count] = await Promise.all([
    contactAddresses(c.env.DB, contact),
    c.env.DB.prepare(
      `SELECT t.id, t.mailbox_id, m.address AS mailbox_address, t.subject, t.status,
              t.last_message_at
       FROM threads t
       JOIN mailboxes m ON m.id = t.mailbox_id
       WHERE t.id IN (${fromContact})
       ORDER BY t.last_message_at DESC, t.id DESC
       LIMIT ${CONTACT_CONVERSATION_LIMIT}`,
    )
      .bind(contact.address, contact.id)
      .all<ContactConversation>(),
    c.env.DB.prepare(`SELECT COUNT(*) AS count FROM (${fromContact})`)
      .bind(contact.address, contact.id)
      .first<{ count: number }>(),
  ]);
  const detail: ContactDetail = {
    contact,
    addresses,
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

  const existing = await contactWithAddress(c.env.DB, address);
  if (existing) {
    return c.json({ error: "A contact with this address already exists", id: existing }, 409);
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
 * Adds or updates many Contacts at once. New addresses become Contacts; an
 * address any Contact already has, primary or not, updates that Contact:
 * imported details fill empty fields, or replace them when `overwrite` is
 * set. Blank imported values never clear a field.
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
      `SELECT COUNT(*) AS count FROM contact_addresses
       WHERE address IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(...chunk)
      .first<{ count: number }>();
    result.updated += Number(existing?.count ?? 0);
  }
  result.created = addresses.length - result.updated;

  const statements = [...rows.values()].flatMap((row) => [
    c.env.DB.prepare(
      `UPDATE contacts SET
         name = CASE WHEN ?6 THEN COALESCE(?2, name) ELSE COALESCE(name, ?2) END,
         company = CASE WHEN ?6 THEN COALESCE(?3, company) ELSE COALESCE(company, ?3) END,
         phone = CASE WHEN ?6 THEN COALESCE(?4, phone) ELSE COALESCE(phone, ?4) END,
         notes = CASE WHEN ?6 THEN COALESCE(?5, notes) ELSE COALESCE(notes, ?5) END,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id IN (SELECT contact_id FROM contact_addresses WHERE address = ?1)`,
    ).bind(...row, overwrite),
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO contacts (address, name, company, phone, notes, last_seen_at)
       SELECT ?1, ?2, ?3, ?4, ?5, (
         SELECT MAX(created_at) FROM messages
         WHERE from_address = ?1 COLLATE NOCASE AND direction = 'inbound'
       )
       WHERE NOT EXISTS (SELECT 1 FROM contact_addresses WHERE address = ?1)`,
    ).bind(...row),
  ]);
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
    return c.json({ error: "Send the contact's email addresses as addresses, primary first" }, 400);
  }
  const parsed = parseContactFields(body);
  if ("error" in parsed) return c.json({ error: parsed.error }, 400);
  const entries = Object.entries(parsed.fields);
  const addresses = body.addresses === undefined ? null : parseContactAddresses(body.addresses);
  if (addresses && "error" in addresses) return c.json({ error: addresses.error }, 400);
  if (entries.length === 0 && !addresses) return c.json({ error: "no fields to update" }, 400);

  const current = await c.env.DB.prepare("SELECT * FROM contacts WHERE id = ?")
    .bind(id)
    .first<Contact>();
  if (!current) return c.json({ error: "Contact not found" }, 404);

  const statements: D1PreparedStatement[] = [];
  if (addresses) {
    const list = addresses.addresses;
    const placeholders = list.map(() => "?").join(", ");
    const inbox = await c.env.DB.prepare(
      `SELECT address FROM mailboxes WHERE address IN (${placeholders}) LIMIT 1`,
    )
      .bind(...list)
      .first<{ address: string }>();
    if (inbox) {
      return c.json({ error: `${inbox.address} is one of this workspace's inboxes` }, 400);
    }
    const taken = await c.env.DB.prepare(
      `SELECT address, contact_id FROM contact_addresses
       WHERE address IN (${placeholders}) AND contact_id <> ?
       UNION ALL
       SELECT address, id FROM contacts WHERE address IN (${placeholders}) AND id <> ?
       LIMIT 1`,
    )
      .bind(...list, id, ...list, id)
      .first<{ address: string; contact_id: number }>();
    if (taken) {
      return c.json(
        { error: `${taken.address} already belongs to another contact`, id: taken.contact_id },
        409,
      );
    }
    statements.push(
      c.env.DB.prepare("DELETE FROM contact_addresses WHERE contact_id = ?").bind(id),
      ...list.map((address) =>
        c.env.DB.prepare("INSERT INTO contact_addresses (address, contact_id) VALUES (?, ?)")
          .bind(address, id),
      ),
      // The primary address is the first; last seen covers mail from every address.
      c.env.DB.prepare(
        `UPDATE contacts SET
           address = ?1,
           last_seen_at = COALESCE((
             SELECT MAX(created_at) FROM messages
             WHERE direction = 'inbound' AND from_address COLLATE NOCASE IN (
               SELECT address FROM contact_addresses WHERE contact_id = ?2
             )
           ), last_seen_at),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?2`,
      ).bind(list[0], id),
    );
  }
  if (entries.length > 0) {
    statements.push(
      c.env.DB.prepare(
        `UPDATE contacts
         SET ${entries.map(([field]) => `${field} = ?`).join(", ")},
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      ).bind(...entries.map(([, value]) => value), id),
    );
  }
  await c.env.DB.batch(statements);

  const contact = await c.env.DB.prepare("SELECT * FROM contacts WHERE id = ?")
    .bind(id)
    .first<Contact>();
  if (!contact) return c.json({ error: "Contact not found" }, 404);
  return c.json(contact);
});

contactsApi.delete("/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid contact id" }, 400);
  const [, result] = await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM contact_addresses WHERE contact_id = ?").bind(id),
    c.env.DB.prepare("DELETE FROM contacts WHERE id = ?").bind(id),
  ]);
  if (!result.meta.changes) return c.json({ error: "Contact not found" }, 404);
  return c.json({ ok: true });
});

/** Every address of a contact, primary first. */
async function contactAddresses(db: D1Database, contact: Contact): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT address FROM contact_addresses WHERE contact_id = ? ORDER BY address")
    .bind(contact.id)
    .all<{ address: string }>();
  const primary = contact.address.toLowerCase();
  return [primary, ...results.map((row) => row.address).filter((address) => address !== primary)];
}

/** The id of the contact that has this address, primary or not. */
async function contactWithAddress(db: D1Database, address: string): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT contact_id AS id FROM contact_addresses WHERE address = ?1
       UNION ALL SELECT id FROM contacts WHERE address = ?1 LIMIT 1`,
    )
    .bind(address)
    .first<{ id: number }>();
  return row?.id ?? null;
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
