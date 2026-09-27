import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  deleteInbox,
  InboxDeletionError,
  purgeInboxObjects,
} from "../src/worker/inbox/delete.ts";

class SqliteD1Statement {
  constructor(database, sql, args = []) {
    this.database = database;
    this.sql = sql;
    this.args = args;
  }

  bind(...args) {
    return new SqliteD1Statement(this.database, this.sql, args);
  }

  async first() {
    return this.database.prepare(this.sql).get(...this.args) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.sql).all(...this.args) };
  }

  async run() {
    const result = this.database.prepare(this.sql).run(...this.args);
    return {
      success: true,
      meta: {
        changes: Number(result.changes),
        last_row_id: Number(result.lastInsertRowid),
      },
    };
  }
}

class SqliteD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database, sql);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class FakeR2 {
  constructor(keys) {
    this.keys = new Set(keys);
    this.deleted = [];
  }

  async list({ prefix, limit = 1_000 }) {
    const objects = [...this.keys]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, limit)
      .map((key) => ({ key }));
    return { objects, delimitedPrefixes: [], truncated: false };
  }

  async delete(input) {
    const keys = Array.isArray(input) ? input : [input];
    for (const key of keys) {
      this.keys.delete(key);
      this.deleted.push(key);
    }
  }
}

function makeFixture() {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  for (const filename of readdirSync("migrations").filter((name) => name.endsWith(".sql")).sort()) {
    database.exec(readFileSync(`migrations/${filename}`, "utf8"));
  }

  database.exec(`
    INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES
      (1, 'support@example.com', 1),
      (2, 'sales@example.com', 1);
    INSERT INTO threads
      (id, mailbox_id, subject, normalized_subject, snippet, message_count, last_message_at)
    VALUES
      (10, 1, 'Target', 'target', 'target', 1, '2026-09-01T00:00:00.000Z'),
      (20, 2, 'Sibling', 'sibling', 'sibling', 1, '2026-09-01T00:00:00.000Z');
    INSERT INTO messages
      (id, thread_id, message_id, direction, from_address, subject, text_body, raw_key)
    VALUES
      (100, 10, '<target@example.com>', 'inbound', 'customer@example.net', 'Target', 'Target body', 'raw/1/target.eml'),
      (200, 20, '<sibling@example.com>', 'inbound', 'customer@example.net', 'Sibling', 'Sibling body', 'raw/2/sibling.eml');
    INSERT INTO attachments (id, message_id, content_type, size, r2_key)
    VALUES (1000, 100, 'text/plain', 6, 'attachments/1/100/file');
    INSERT INTO playbooks (id, mailbox_id, name, when_to_use, instructions)
    VALUES (1000, 1, 'Returns', 'A return request', 'Reply carefully');
    INSERT INTO drafts
      (id, thread_id, text_body, created_by, playbook_id, source_inbound_message_id)
    VALUES (1000, 10, 'Draft', 'agent', 1000, 100);
    INSERT INTO draft_runs
      (id, thread_id, inbound_message_id, status, draft_id)
    VALUES (1000, 10, 100, 'ready', 1000);
    INSERT INTO reply_attempts
      (id, thread_id, inbound_message_id, draft_id, status, text_body, to_addresses)
    VALUES ('reply-sent', 10, 100, 1000, 'sent', 'Reply', '["customer@example.net"]');
    INSERT INTO outbound_attempts
      (id, mailbox_id, thread_id, status, to_addresses, subject, text_body)
    VALUES ('outbound-sent', 1, 10, 'sent', '["customer@example.net"]', 'Target', 'Sent');
    INSERT INTO labels (id, mailbox_id, name, condition)
    VALUES (500, 1, 'guest-post', 'A guest post pitch');
    INSERT INTO thread_labels (thread_id, label_id) VALUES (10, 500);
  `);

  const RAW = new FakeR2([
    "raw/1/target.eml",
    "attachments/1/100/file",
    "raw/2/sibling.eml",
  ]);
  return { database, DB: new SqliteD1(database), RAW };
}

function count(database, table, where = "1 = 1") {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count);
}

test("deleting an inbox removes its data and objects but keeps its domain and siblings", async () => {
  const fixture = makeFixture();
  const deleted = await deleteInbox(fixture, {
    id: 1,
    confirmAddress: "support@example.com",
  });
  await purgeInboxObjects(fixture.RAW, deleted.id);

  assert.deepEqual(deleted, { id: 1, address: "support@example.com", domainId: 1 });
  assert.equal(count(fixture.database, "mailboxes", "id = 1"), 0);
  assert.equal(count(fixture.database, "mailboxes", "id = 2"), 1);
  assert.equal(count(fixture.database, "domains", "id = 1"), 1);
  for (const table of [
    "threads",
    "messages",
    "attachments",
    "drafts",
    "draft_runs",
    "reply_attempts",
    "outbound_attempts",
    "playbooks",
    "labels",
    "thread_labels",
  ]) {
    assert.equal(count(fixture.database, table), table === "threads" || table === "messages" ? 1 : 0);
  }
  assert.deepEqual(fixture.RAW.deleted.sort(), [
    "attachments/1/100/file",
    "raw/1/target.eml",
  ]);
  assert.deepEqual([...fixture.RAW.keys], ["raw/2/sibling.eml"]);
});

test("an unknown inbox returns 404 without deleting data or objects", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    deleteInbox(fixture, { id: 999, confirmAddress: "missing@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 404,
  );
  assert.equal(count(fixture.database, "mailboxes"), 2);
  assert.equal(fixture.RAW.deleted.length, 0);
});

test("the exact inbox address is required before deletion", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    deleteInbox(fixture, { id: 1, confirmAddress: "sales@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 400,
  );
  assert.equal(count(fixture.database, "mailboxes"), 2);
  assert.equal(fixture.RAW.deleted.length, 0);
});

test("an active send blocks inbox deletion", async () => {
  const fixture = makeFixture();
  fixture.database.prepare("UPDATE reply_attempts SET status = 'sending' WHERE id = 'reply-sent'").run();

  await assert.rejects(
    deleteInbox(fixture, { id: 1, confirmAddress: "support@example.com" }),
    (error) => error instanceof InboxDeletionError && error.status === 409,
  );
  assert.equal(count(fixture.database, "mailboxes", "id = 1"), 1);
  assert.equal(fixture.RAW.deleted.length, 0);
});
