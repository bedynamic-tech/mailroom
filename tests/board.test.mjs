import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { boardApi } from "../src/worker/api/board.ts";
import { requireSameOrigin } from "../src/worker/api/csrf.ts";
import { cardTitleFromSubject } from "../src/shared/board.ts";
import { deleteArchivedConversations } from "../src/worker/inbox/delete-conversations.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads (id, mailbox_id, subject, last_message_at, status)
      VALUES (1, 1, 'Refund request', '2026-01-01T00:00:00.000Z', 'open'),
             (2, 1, 'Broken invoice', '2026-01-02T00:00:00.000Z', 'archived');`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes, last_row_id: result.lastInsertRowid } }; },
    };
  }
  const env = {
    DB: {
      prepare: statement,
      async batch(statements) {
        db.exec("BEGIN IMMEDIATE");
        try { const results = []; for (const item of statements) results.push(await item.run()); db.exec("COMMIT"); return results; }
        catch (error) { db.exec("ROLLBACK"); throw error; }
      },
    },
    RAW: { async delete() {} },
  };
  const app = new Hono();
  app.use("/api/*", requireSameOrigin);
  app.route("/api/board", boardApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/board${path}`, {
      method,
      headers: { Origin: "https://mailroom.example", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  return { db, env, call };
}

test("the board starts with three columns", async (t) => {
  const f = fixture(t);
  const { body } = await f.call("GET", "");
  assert.deepEqual(body.columns.map((column) => column.name), ["To do", "In progress", "Done"]);
  assert.deepEqual(body.cards, []);
});

test("columns can be added, renamed, reordered and deleted with their cards", async (t) => {
  const f = fixture(t);
  const added = await f.call("POST", "/columns", { name: "  Waiting   on customer " });
  assert.equal(added.status, 201);
  assert.equal(added.body.name, "Waiting on customer");
  assert.equal(added.body.position, 3);

  assert.equal((await f.call("POST", "/columns", { name: " " })).status, 400);
  const renamed = await f.call("PATCH", `/columns/${added.body.id}`, { name: "Blocked" });
  assert.equal(renamed.body.name, "Blocked");

  const board = (await f.call("GET", "")).body;
  const ids = board.columns.map((column) => column.id).reverse();
  const reordered = await f.call("PUT", "/columns/order", { ids });
  assert.deepEqual(reordered.body.columns.map((column) => column.name), ["Blocked", "Done", "In progress", "To do"]);
  assert.equal((await f.call("PUT", "/columns/order", { ids: ids.slice(1) })).status, 409);

  const card = await f.call("POST", "/cards", { column_id: added.body.id, title: "Chase", thread_ids: [1] });
  assert.equal(card.status, 201);
  assert.equal((await f.call("DELETE", `/columns/${added.body.id}`)).status, 200);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM board_cards").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM board_card_threads").get().n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM threads").get().n, 2);
});

test("the last column can't be deleted", async (t) => {
  const f = fixture(t);
  const { body } = await f.call("GET", "");
  await f.call("DELETE", `/columns/${body.columns[0].id}`);
  await f.call("DELETE", `/columns/${body.columns[1].id}`);
  const last = await f.call("DELETE", `/columns/${body.columns[2].id}`);
  assert.equal(last.status, 400);
});

test("cards are created in the first column by default, linked to conversations", async (t) => {
  const f = fixture(t);
  const created = await f.call("POST", "/cards", {
    title: "Refund request",
    description: "  Check the order \r\n first ",
    thread_ids: [1, 1],
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.description, "Check the order \n first");
  assert.equal(created.body.column_id, (await f.call("GET", "")).body.columns[0].id);
  assert.deepEqual(created.body.conversations, [
    { id: 1, subject: "Refund request", status: "open", mailbox_address: "support@example.com" },
  ]);

  assert.equal((await f.call("POST", "/cards", { title: "" })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", thread_ids: [99] })).status, 404);
  assert.equal((await f.call("POST", "/cards", { title: "x", column_id: 99 })).status, 404);

  const linked = await f.call("POST", `/cards/${created.body.id}/conversations`, { thread_id: 2 });
  assert.deepEqual(linked.body.conversations.map((c) => c.id), [1, 2]);
  const unlinked = await f.call("DELETE", `/cards/${created.body.id}/conversations/1`);
  assert.deepEqual(unlinked.body.conversations.map((c) => c.id), [2]);

  const edited = await f.call("PATCH", `/cards/${created.body.id}`, { title: "Refund", description: "" });
  assert.equal(edited.body.title, "Refund");
  assert.equal(edited.body.description, null);

  assert.equal((await f.call("DELETE", `/cards/${created.body.id}`)).status, 200);
  assert.equal((await f.call("GET", `/cards/${created.body.id}`)).status, 404);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM board_card_threads").get().n, 0);
});

test("moving a card renumbers its new column", async (t) => {
  const f = fixture(t);
  const [todo, doing] = (await f.call("GET", "")).body.columns;
  const a = (await f.call("POST", "/cards", { title: "A" })).body;
  const b = (await f.call("POST", "/cards", { title: "B" })).body;
  const c = (await f.call("POST", "/cards", { title: "C", column_id: doing.id })).body;
  assert.deepEqual([a.position, b.position, c.position], [0, 1, 0]);

  let board = (await f.call("POST", `/cards/${b.id}/move`, { column_id: doing.id, index: 0 })).body;
  const order = (columnId) => board.cards
    .filter((card) => card.column_id === columnId)
    .sort((x, y) => x.position - y.position)
    .map((card) => card.title);
  assert.deepEqual(order(doing.id), ["B", "C"]);
  assert.deepEqual(order(todo.id), ["A"]);

  board = (await f.call("POST", `/cards/${b.id}/move`, { column_id: doing.id, index: 9 })).body;
  assert.deepEqual(order(doing.id), ["C", "B"]);
  board = (await f.call("POST", `/cards/${c.id}/move`, { column_id: todo.id, index: 0 })).body;
  assert.deepEqual(order(todo.id), ["C", "A"]);

  assert.equal((await f.call("POST", `/cards/${c.id}/move`, { column_id: todo.id, index: -1 })).status, 400);
  assert.equal((await f.call("POST", `/cards/${c.id}/move`, { column_id: 99, index: 0 })).status, 404);
});

test("deleting a conversation removes its card links but keeps the card", async (t) => {
  const f = fixture(t);
  const card = (await f.call("POST", "/cards", { title: "Invoice", thread_ids: [1, 2] })).body;
  await deleteArchivedConversations(f.env, { ids: [2] });
  const after = (await f.call("GET", `/cards/${card.id}`)).body;
  assert.deepEqual(after.conversations.map((c) => c.id), [1]);
});

test("card titles from subjects drop reply and forward prefixes", () => {
  assert.equal(cardTitleFromSubject("Re: Fwd: RE[2]: Refund"), "Refund");
  assert.equal(cardTitleFromSubject("  Order 42 "), "Order 42");
  assert.equal(cardTitleFromSubject(null), "");
});

test("suggestions are newer conversations from the senders a card already links", async (t) => {
  const f = fixture(t);
  f.db.exec(`INSERT INTO threads (id, mailbox_id, subject, last_message_at, status)
      VALUES (3, 1, 'Refund follow-up', '2026-01-03T00:00:00.000Z', 'open'),
             (4, 1, 'Unrelated', '2026-01-04T00:00:00.000Z', 'open');
    INSERT INTO messages (thread_id, message_id, direction, from_address, from_name, created_at) VALUES
      (1, '<a@x>', 'inbound', 'ada@example.org', 'Ada', '2026-01-01T00:00:00.000Z'),
      (3, '<b@x>', 'inbound', 'ADA@example.org', 'Ada L', '2026-01-03T00:00:00.000Z'),
      (4, '<c@x>', 'inbound', 'bob@example.org', 'Bob', '2026-01-04T00:00:00.000Z');`);
  const card = (await f.call("POST", "/cards", { title: "Refund", thread_ids: [1] })).body;
  const { body } = await f.call("GET", `/cards/${card.id}/suggestions`);
  assert.deepEqual(body.map((row) => [row.id, row.last_from]), [[3, "Ada L"]]);

  await f.call("POST", `/cards/${card.id}/conversations`, { thread_id: 3 });
  assert.deepEqual((await f.call("GET", `/cards/${card.id}/suggestions`)).body, []);
});
