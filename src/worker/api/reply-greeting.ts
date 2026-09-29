import { Hono } from "hono";
import {
  MAX_REPLY_GREETING_LENGTH,
  normalizeGreetingTemplate,
} from "../../shared/reply-greeting.ts";

type GreetingEnv = { Bindings: { DB: D1Database } };

/** Saves the Reply greeting setting (see shared/reply-greeting.ts). */
export const replyGreetingApi = new Hono<GreetingEnv>();

replyGreetingApi.put("/", async (c) => {
  const body = await c.req.json<{ enabled?: unknown; template?: unknown }>().catch(() => null);
  if (typeof body?.enabled !== "boolean") {
    return c.json({ error: "enabled must be true or false" }, 400);
  }
  const template = body.template ?? null;
  if (template !== null && typeof template !== "string") {
    return c.json({ error: "The greeting must be text" }, 400);
  }
  const normalized = normalizeGreetingTemplate(template);
  if (normalized && normalized.length > MAX_REPLY_GREETING_LENGTH) {
    return c.json({ error: `Keep the greeting under ${MAX_REPLY_GREETING_LENGTH} characters` }, 400);
  }
  await c.env.DB.prepare(
    `UPDATE global_settings
     SET reply_greeting_enabled = ?,
         reply_greeting_template = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = 1`,
  )
    .bind(body.enabled ? 1 : 0, normalized)
    .run();
  return c.json({ ok: true, enabled: body.enabled, template: normalized });
});

/**
 * Contact names for the given addresses, keyed by lowercase address. Any of a
 * Contact's addresses matches it. Contacts without a name are left out.
 */
export async function contactNamesFor(
  db: D1Database,
  addresses: string[],
): Promise<Record<string, string>> {
  const unique = [...new Set(addresses.map((address) => address.trim().toLowerCase()).filter(Boolean))]
    .slice(0, 200);
  if (unique.length === 0) return {};
  const placeholders = unique.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `SELECT lower(ca.address) AS address, c.name
       FROM contact_addresses ca JOIN contacts c ON c.id = ca.contact_id
       WHERE ca.address IN (${placeholders}) AND c.name IS NOT NULL AND trim(c.name) != ''`,
    )
    .bind(...unique)
    .all<{ address: string; name: string }>();
  return Object.fromEntries(results.map((row) => [row.address, row.name]));
}
