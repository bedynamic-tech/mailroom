import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { contactNamesFor, replyGreetingApi } from "../src/worker/api/reply-greeting.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import {
  firstNameFrom,
  normalizeGreetingTemplate,
  replyGreetingHtml,
  replyGreetingLine,
} from "../src/shared/reply-greeting.ts";
import { richTextToPlainText } from "../src/shared/rich-text.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
    };
  }
  const env = { DB: { prepare: statement } };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/settings/reply-greeting", replyGreetingApi);
  const put = async (body) => {
    const response = await app.request("https://mailroom.example/api/settings/reply-greeting", {
      method: "PUT",
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  const stored = () => db.prepare("SELECT reply_greeting_enabled AS enabled, reply_greeting_template AS template FROM global_settings WHERE id = 1").get();
  return { db, env, put, stored };
}

test("the reply greeting is off by default and saves its template", async (t) => {
  const f = fixture(t);
  assert.deepEqual({ ...f.stored() }, { enabled: 0, template: null });
  assert.equal((await f.put({ enabled: true, template: "  Hi   {first_name}, " })).status, 200);
  assert.deepEqual({ ...f.stored() }, { enabled: 1, template: "Hi {first_name}," });
  // The default template and a blank one are stored as the default.
  await f.put({ enabled: true, template: "{first_name}," });
  assert.equal(f.stored().template, null);
  await f.put({ enabled: false, template: "" });
  assert.deepEqual({ ...f.stored() }, { enabled: 0, template: null });
});

test("invalid reply greeting settings are refused", async (t) => {
  const f = fixture(t);
  assert.equal((await f.put({ enabled: "yes" })).status, 400);
  assert.equal((await f.put({ enabled: true, template: 5 })).status, 400);
  assert.equal((await f.put({ enabled: true, template: "x".repeat(201) })).status, 400);
  assert.deepEqual({ ...f.stored() }, { enabled: 0, template: null });
});

test("contact names are found by any of a contact's addresses", async (t) => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO contacts (id, address, name) VALUES (1, 'jane@example.com', 'Jane Doe'), (2, 'noname@example.com', NULL);
    INSERT INTO contact_addresses (address, contact_id) VALUES ('jane.work@example.com', 1);`);
  assert.deepEqual(
    await contactNamesFor(f.env.DB, ["Jane.Work@example.com", "noname@example.com", "stranger@example.com"]),
    { "jane.work@example.com": "Jane Doe" },
  );
  assert.deepEqual(await contactNamesFor(f.env.DB, []), {});
});

test("first names come from display names", () => {
  assert.equal(firstNameFrom("Jane Doe"), "Jane");
  assert.equal(firstNameFrom("\"Doe, Jane\""), "Jane");
  assert.equal(firstNameFrom("JANE DOE"), "Jane");
  assert.equal(firstNameFrom("Jane Doe, PhD"), "Jane");
  assert.equal(firstNameFrom("Mary-Kate O'Neil"), "Mary-Kate");
  assert.equal(firstNameFrom("jane@example.com"), null);
  assert.equal(firstNameFrom("  "), null);
  assert.equal(firstNameFrom(null), null);
  assert.equal(firstNameFrom("123"), null);
});

test("the greeting line fills in the first name, or is left out without one", () => {
  assert.equal(replyGreetingLine(null, "Jane"), "Jane,");
  assert.equal(replyGreetingLine("Hi {first_name},", "Jane"), "Hi Jane,");
  assert.equal(replyGreetingLine(null, null), null);
  assert.equal(replyGreetingLine("Hello,", null), "Hello,");
  assert.equal(normalizeGreetingTemplate("   "), null);
});

test("the greeting is followed by a blank line and an empty line for the cursor", () => {
  const html = replyGreetingHtml("Hi <Jane>,");
  assert.equal(html, "<div>Hi &lt;Jane&gt;,</div><div><br></div><div><br></div>");
  assert.equal(richTextToPlainText(html), "Hi <Jane>,");
});
