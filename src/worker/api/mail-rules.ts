import { Hono, type Context } from "hono";
import {
  createMailRule,
  deleteMailRule,
  listMailRules,
  MailRuleError,
  updateMailRule,
} from "../email/mail-rules.ts";

type MailRulesContext = Context<{ Bindings: { DB: D1Database } }>;

export const mailRulesApi = new Hono<{ Bindings: { DB: D1Database } }>();

mailRulesApi.get("/", async (c) => c.json(await listMailRules(c.env)));

mailRulesApi.post("/", async (c) => {
  const body = await c.req.json().catch(() => null);
  return handle(c, async () => c.json(await createMailRule(c.env, body), 201));
});

mailRulesApi.put("/:id", async (c) => {
  const id = ruleId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid rule id" }, 400);
  const body = await c.req.json().catch(() => null);
  return handle(c, async () => c.json(await updateMailRule(c.env, id, body)));
});

mailRulesApi.delete("/:id", async (c) => {
  const id = ruleId(c.req.param("id"));
  if (id === null) return c.json({ error: "invalid rule id" }, 400);
  return handle(c, async () => {
    await deleteMailRule(c.env, id);
    return c.json({ ok: true });
  });
});

function ruleId(value: string): number | null {
  return /^\d+$/.test(value) ? Number(value) : null;
}

async function handle(c: MailRulesContext, run: () => Promise<Response>): Promise<Response> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof MailRuleError) return c.json({ error: error.message }, error.status);
    throw error;
  }
}
