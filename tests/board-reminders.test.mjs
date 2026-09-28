import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import { boardApi, scheduleFields } from "../src/worker/api/board.ts";
import { formatDueTime, reminderTime } from "../src/shared/board.ts";
import {
  buildReminderEmail,
  buildReminderPush,
  sendDueReminders,
} from "../src/worker/notifications/reminders.ts";

function fixture(t) {
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  for (const file of readdirSync("migrations").filter((file) => file.endsWith(".sql")).sort()) {
    db.exec(readFileSync(`migrations/${file}`, "utf8"));
  }
  db.exec(`INSERT INTO domains (id, name, status) VALUES (1, 'example.com', 'active');
    INSERT INTO mailboxes (id, address, domain_id) VALUES (1, 'support@example.com', 1);`);
  function statement(sql, args = []) {
    return {
      bind: (...values) => statement(sql, values),
      async first() { return db.prepare(sql).get(...args) ?? null; },
      async all() { return { results: db.prepare(sql).all(...args) }; },
      async run() { const result = db.prepare(sql).run(...args); return { meta: { changes: result.changes } }; },
    };
  }
  const sent = [];
  const env = {
    DB: {
      prepare: statement,
      async batch(statements) {
        const results = [];
        for (const item of statements) results.push(await item.run());
        return results;
      },
    },
    EMAIL: {
      async send(message) {
        sent.push(message);
        return { messageId: `<${sent.length}@example.com>` };
      },
    },
  };
  const app = new Hono();
  app.route("/api/board", boardApi);
  const call = async (method, path, body) => {
    const response = await app.request(`https://mailroom.example/api/board${path}`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }, env);
    return { status: response.status, body: await response.json() };
  };
  const row = (id) => db.prepare("SELECT * FROM board_cards WHERE id = ?").get(id);
  return { db, env, call, row, sent };
}

const inAnHour = () => new Date(Date.now() + 60 * 60_000).toISOString();

test("a new item keeps its due time, time zone and reminder", async (t) => {
  const f = fixture(t);
  const due = inAnHour();
  const created = await f.call("POST", "/cards", {
    title: "Call the customer back",
    due_at: due,
    due_time_zone: "America/Chicago",
    reminder_minutes: 15,
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.due_at, due);
  assert.equal(created.body.due_time_zone, "America/Chicago");
  assert.equal(created.body.reminder_minutes, 15);
  assert.equal(created.body.reminder_sent_at, null);
  assert.equal(f.row(created.body.id).remind_at, reminderTime(due, 15));

  const plain = await f.call("POST", "/cards", { title: "No date" });
  assert.equal(plain.body.due_at, null);
  assert.equal(plain.body.reminder_minutes, null);
});

test("invalid due dates, zones and reminders are rejected", async (t) => {
  const f = fixture(t);
  assert.equal((await f.call("POST", "/cards", { title: "x", due_at: "tomorrow" })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", due_at: "1990-01-01T00:00:00Z" })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", due_at: inAnHour(), due_time_zone: "Mars/Base" })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", due_at: inAnHour(), reminder_minutes: 7 })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", reminder_minutes: 5 })).status, 400);
  assert.equal((await f.call("POST", "/cards", { title: "x", due_at: null, reminder_minutes: 5 })).status, 400);
});

test("a due time already past never sends a reminder", () => {
  const now = Date.parse("2026-09-28T12:00:00Z");
  const past = scheduleFields({ due_at: "2026-09-28T11:00:00Z", reminder_minutes: 0 }, now);
  assert.equal(past.set.expired, true);
  // Due later, but the reminder time has passed: it goes out on the next run.
  const soon = scheduleFields({ due_at: "2026-09-28T12:30:00Z", reminder_minutes: 60 }, now);
  assert.equal(soon.set.expired, false);
  assert.equal(soon.set.remind_at, "2026-09-28T11:30:00.000Z");
});

test("saving an unchanged due time keeps a sent reminder from going out again", async (t) => {
  const f = fixture(t);
  const due = inAnHour();
  const { body: card } = await f.call("POST", "/cards", { title: "Renewal", due_at: due, reminder_minutes: 60 });
  f.db.prepare("UPDATE board_cards SET reminder_sent_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(card.id);

  const same = await f.call("PATCH", `/cards/${card.id}`, { title: "Renewal!", due_at: due, reminder_minutes: 60 });
  assert.equal(same.status, 200);
  assert.equal(same.body.reminder_sent_at, "2026-01-01T00:00:00.000Z");

  const titleOnly = await f.call("PATCH", `/cards/${card.id}`, { title: "Renewal" });
  assert.equal(titleOnly.body.due_at, due);
  assert.equal(titleOnly.body.reminder_sent_at, "2026-01-01T00:00:00.000Z");

  const moved = await f.call("PATCH", `/cards/${card.id}`, { due_at: due, reminder_minutes: 30 });
  assert.equal(moved.body.reminder_sent_at, null);
  assert.equal(f.row(card.id).remind_at, reminderTime(due, 30));

  const cleared = await f.call("PATCH", `/cards/${card.id}`, { due_at: null });
  assert.equal(cleared.body.due_at, null);
  assert.equal(cleared.body.reminder_minutes, null);
  assert.equal(f.row(card.id).remind_at, null);
});

test("due reminders are emailed once, from an Inbox, with a link to the item", async (t) => {
  const f = fixture(t);
  f.db.exec(`UPDATE global_settings SET email_notifications_enabled = 1,
    email_notification_address = 'me@personal.test', email_notification_origin = 'https://mail.example.com'`);
  const { body: due } = await f.call("POST", "/cards", {
    title: "Send the quote",
    description: "Include shipping",
    due_at: inAnHour(),
    due_time_zone: "America/New_York",
    reminder_minutes: 60,
  });
  const { body: later } = await f.call("POST", "/cards", {
    title: "Later",
    due_at: new Date(Date.now() + 3 * 60 * 60_000).toISOString(),
    reminder_minutes: 60,
  });

  assert.deepEqual(await sendDueReminders(f.env), { sent: 1 });
  assert.equal(f.sent.length, 1);
  const [mail] = f.sent;
  assert.equal(mail.to[0], "me@personal.test");
  assert.equal(mail.subject, "Reminder: Send the quote");
  assert.match(mail.text, /Column: To do/);
  assert.match(mail.text, /Include shipping/);
  assert.match(mail.text, new RegExp(`https://mail\\.example\\.com/board/cards/${due.id}`));
  assert.equal(mail.headers["Auto-Submitted"], "auto-generated");
  assert.ok(f.row(due.id).reminder_sent_at);
  assert.equal(f.row(later.id).reminder_sent_at, null);

  assert.deepEqual(await sendDueReminders(f.env), { sent: 0 });
  assert.equal(f.sent.length, 1);
});

test("reminders are only emailed while email notifications are on and the box is checked", async (t) => {
  const f = fixture(t);
  f.db.exec("UPDATE global_settings SET email_notification_address = 'me@personal.test'");
  await f.call("POST", "/cards", { title: "Off", due_at: inAnHour(), reminder_minutes: 60 });
  assert.deepEqual(await sendDueReminders(f.env), { sent: 1 });
  assert.equal(f.sent.length, 0);

  f.db.exec("UPDATE global_settings SET email_notifications_enabled = 1, email_board_reminders = 0");
  await f.call("POST", "/cards", { title: "Unchecked", due_at: inAnHour(), reminder_minutes: 60 });
  assert.deepEqual(await sendDueReminders(f.env), { sent: 1 });
  assert.equal(f.sent.length, 0);

  f.db.exec("UPDATE global_settings SET email_board_reminders = 1");
  await f.call("POST", "/cards", { title: "Checked", due_at: inAnHour(), reminder_minutes: 60 });
  assert.deepEqual(await sendDueReminders(f.env), { sent: 1 });
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0].subject, "Reminder: Checked");
});

test("reminder emails never go to one of the workspace's own Inboxes", async (t) => {
  const f = fixture(t);
  f.db.exec(`UPDATE global_settings SET email_notifications_enabled = 1,
    email_notification_address = 'support@example.com'`);
  await f.call("POST", "/cards", { title: "Loop", due_at: inAnHour(), reminder_minutes: 60 });
  assert.deepEqual(await sendDueReminders(f.env), { sent: 1 });
  assert.equal(f.sent.length, 0);
});

test("reminder content shows the due time in the zone it was picked in", () => {
  const reminder = {
    id: 7,
    title: "  Follow   up ",
    description: null,
    due_at: "2026-09-29T19:00:00.000Z",
    due_time_zone: "America/Chicago",
    column_name: null,
  };
  assert.equal(formatDueTime(reminder.due_at, reminder.due_time_zone), "Tue, Sep 29, 2026, 2:00 PM CDT");
  const push = buildReminderPush(reminder);
  assert.equal(push.title, "Reminder: Follow up");
  assert.equal(push.body, "Due Tue, Sep 29, 2026, 2:00 PM CDT");
  assert.equal(push.data.url, "/board/cards/7");
  const email = buildReminderEmail(reminder, null);
  assert.doesNotMatch(email.text, /Open it/);
  assert.doesNotMatch(email.text, /Column/);
});
