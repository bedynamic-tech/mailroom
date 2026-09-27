import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import {
  ConversationDeletionError,
  deleteArchivedConversations,
  emptyArchive,
  purgeConversationObjects,
} from "../src/worker/inbox/delete-conversations.ts";

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
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);
    INSERT INTO threads
      (id, mailbox_id, subject, normalized_subject, snippet, status, message_count, last_message_at)
    VALUES
      (10, 1, 'Archived', 'archived', 'archived', 'archived', 2, '2026-09-01T00:00:00.000Z'),
      (20, 1, 'Open', 'open', 'open', 'open', 1, '2026-09-01T00:00:00.000Z'),
      (30, 1, 'Also archived', 'also archived', 'also', 'archived', 1, '2026-09-01T00:00:00.000Z');
    INSERT INTO messages
      (id, thread_id, message_id, direction, from_address, subject, text_body, raw_key)
    VALUES
      (100, 10, '<archived@example.com>', 'inbound', 'customer@example.net', 'Archived', 'Archived body', 'raw/1/archived.eml'),
      (101, 10, '<reply@example.com>', 'outbound', 'support@example.com', 'Re: Archived', 'Reply body', NULL),
      (200, 20, '<open@example.com>', 'inbound', 'customer@example.net', 'Open', 'Open body', 'raw/1/open.eml'),
      (300, 30, '<also@example.com>', 'inbound', 'customer@example.net', 'Also', 'Also body', 'raw/1/also.eml');
    INSERT INTO attachments (id, message_id, content_type, size, r2_key) VALUES
      (1000, 100, 'text/plain', 6, 'attachments/1/100/file'),
      (1001, 101, 'text/plain', 6, 'attachments/1/outbound/reply-sent/0-file');
    INSERT INTO drafts
      (id, thread_id, text_body, created_by, source_inbound_message_id)
    VALUES (1000, 10, 'Draft', 'agent', 100);
    INSERT INTO draft_runs
      (id, thread_id, inbound_message_id, status, draft_id)
    VALUES (1000, 10, 100, 'ready', 1000);
    INSERT INTO reply_attempts
      (id, thread_id, inbound_message_id, draft_id, status, text_body, to_addresses, attachments)
    VALUES ('reply-sent', 10, 100, 1000, 'sent', 'Reply', '["customer@example.net"]',
      '[{"r2_key":"attachments/1/outbound/reply-sent/0-file"}]');
    INSERT INTO outbound_attempts
      (id, mailbox_id, thread_id, status, to_addresses, subject, text_body)
    VALUES ('outbound-sent', 1, 10, 'sent', '["customer@example.net"]', 'Archived', 'Sent');
    INSERT INTO labels (id, mailbox_id, name, condition)
    VALUES (500, 1, 'guest-post', 'A guest post pitch');
    INSERT INTO thread_labels (thread_id, label_id) VALUES (10, 500), (20, 500);
    INSERT INTO contacts (address, name) VALUES ('customer@example.net', 'Customer');
  `);

  const RAW = new FakeR2([
    "raw/1/archived.eml",
    "attachments/1/100/file",
    "attachments/1/outbound/reply-sent/0-file",
    "raw/1/open.eml",
    "raw/1/also.eml",
  ]);
  return { database, DB: new SqliteD1(database), RAW };
}

function count(database, table, where = "1 = 1") {
  return Number(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get().count);
}

function searchHits(database, term) {
  return Number(
    database.prepare("SELECT COUNT(*) AS count FROM messages_fts WHERE messages_fts MATCH ?").get(term).count,
  );
}

test("deleting an archived conversation removes its data and objects only", async () => {
  const fixture = makeFixture();
  const deleted = await deleteArchivedConversations(fixture, { ids: [10] });
  await purgeConversationObjects(fixture.RAW, deleted.objectKeys);

  assert.deepEqual(deleted.ids, [10]);
  assert.equal(count(fixture.database, "threads", "id = 10"), 0);
  assert.equal(count(fixture.database, "messages", "thread_id = 10"), 0);
  for (const table of ["attachments", "drafts", "draft_runs", "reply_attempts", "outbound_attempts"]) {
    assert.equal(count(fixture.database, table), 0, table);
  }
  assert.equal(count(fixture.database, "thread_labels"), 1);
  assert.equal(count(fixture.database, "labels"), 1);
  assert.equal(count(fixture.database, "contacts"), 1);
  assert.equal(count(fixture.database, "threads"), 2);
  assert.equal(searchHits(fixture.database, "Archived"), 0);
  assert.equal(searchHits(fixture.database, "Open"), 1);
  assert.deepEqual(fixture.RAW.deleted.sort(), [
    "attachments/1/100/file",
    "attachments/1/outbound/reply-sent/0-file",
    "raw/1/archived.eml",
  ]);
  assert.deepEqual([...fixture.RAW.keys].sort(), ["raw/1/also.eml", "raw/1/open.eml"]);
});

test("objects still referenced by a kept message are not purged", async () => {
  const fixture = makeFixture();
  fixture.database.prepare("UPDATE messages SET raw_key = 'raw/1/archived.eml' WHERE id = 200").run();

  const deleted = await deleteArchivedConversations(fixture, { ids: [10] });

  assert.equal(deleted.objectKeys.includes("raw/1/archived.eml"), false);
});

test("an open conversation cannot be deleted", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    deleteArchivedConversations(fixture, { ids: [10, 20] }),
    (error) => error instanceof ConversationDeletionError && error.status === 409,
  );
  assert.equal(count(fixture.database, "threads"), 3);
});

test("an unknown conversation returns 404", async () => {
  const fixture = makeFixture();

  await assert.rejects(
    deleteArchivedConversations(fixture, { ids: [999] }),
    (error) => error instanceof ConversationDeletionError && error.status === 404,
  );
});

test("an active send blocks conversation deletion", async () => {
  const fixture = makeFixture();
  fixture.database.prepare("UPDATE reply_attempts SET status = 'sending' WHERE id = 'reply-sent'").run();

  await assert.rejects(
    deleteArchivedConversations(fixture, { ids: [10] }),
    (error) => error instanceof ConversationDeletionError && error.status === 409,
  );
  assert.equal(count(fixture.database, "threads", "id = 10"), 1);
});

test("emptying the archive deletes every archived conversation and keeps open ones", async () => {
  const fixture = makeFixture();
  const deleted = await emptyArchive(fixture);
  await purgeConversationObjects(fixture.RAW, deleted.objectKeys);

  assert.deepEqual(deleted.ids.sort(), [10, 30]);
  assert.equal(deleted.skipped, 0);
  assert.equal(count(fixture.database, "threads"), 1);
  assert.equal(count(fixture.database, "threads", "id = 20"), 1);
  assert.deepEqual([...fixture.RAW.keys], ["raw/1/open.eml"]);
});

test("emptying the archive skips conversations that are still sending", async () => {
  const fixture = makeFixture();
  fixture.database.prepare("UPDATE outbound_attempts SET status = 'pending' WHERE id = 'outbound-sent'").run();

  const deleted = await emptyArchive(fixture);

  assert.deepEqual(deleted.ids, [30]);
  assert.equal(deleted.skipped, 1);
  assert.equal(count(fixture.database, "threads", "id = 10"), 1);
});
