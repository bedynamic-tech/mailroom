import { sendEmail, type SendEmailEnv } from "../email/send.ts";
import { formatDueTime } from "../../shared/board.ts";
import { pushToSubscribedBrowsers, type PushMessage } from "./push.ts";

/** Most reminders sent in one scheduler run; the rest go out in the next run, 5 minutes later. */
const BATCH_SIZE = 25;

export interface DueReminder {
  id: number;
  title: string;
  description: string | null;
  due_at: string;
  due_time_zone: string | null;
  column_name: string | null;
}

interface ReminderSettings {
  browser_notifications_enabled: number;
  browser_board_reminders: number;
  email_notifications_enabled: number;
  email_board_reminders: number;
  email_notification_address: string | null;
  email_notification_origin: string | null;
}

export function buildReminderPush(reminder: DueReminder): PushMessage {
  const title = oneLine(reminder.title).slice(0, 120) || "Board item";
  return {
    title: `Reminder: ${title}`,
    body: `Due ${formatDueTime(reminder.due_at, reminder.due_time_zone)}`,
    tag: `board-item-${reminder.id}`,
    data: { url: `/board/cards/${reminder.id}`, kind: "board-reminder" },
    topic: `board-item-${reminder.id}`,
  };
}

export function buildReminderEmail(
  reminder: DueReminder,
  origin: string | null,
): { subject: string; text: string } {
  const title = oneLine(reminder.title).slice(0, 160) || "Board item";
  const lines = [
    title,
    "",
    `Due: ${formatDueTime(reminder.due_at, reminder.due_time_zone)}`,
  ];
  if (reminder.column_name) lines.push(`Column: ${reminder.column_name}`);
  const description = (reminder.description ?? "").trim();
  if (description) {
    lines.push("", description.length > 1000 ? `${description.slice(0, 1000)}…` : description);
  }
  if (origin) lines.push("", `Open it: ${origin.replace(/\/$/, "")}/board/cards/${reminder.id}`);
  lines.push("", "Sent by Mailroom + because this board item has a reminder.");
  return { subject: `Reminder: ${title}`, text: lines.join("\n") };
}

/**
 * Sends every reminder whose time has come. Each Item is claimed before
 * sending, so a reminder goes out at most once even if runs overlap; one that
 * fails to deliver is logged, not retried.
 */
export async function sendDueReminders(
  env: Env & SendEmailEnv,
  now: Date = new Date(),
): Promise<{ sent: number }> {
  const claimedAt = now.toISOString();
  const { results } = await env.DB.prepare(
    `UPDATE board_cards SET reminder_sent_at = ?1
     WHERE id IN (
       SELECT id FROM board_cards
       WHERE remind_at IS NOT NULL AND reminder_sent_at IS NULL AND remind_at <= ?1
       ORDER BY remind_at, id LIMIT ${BATCH_SIZE}
     )
     RETURNING id, title, description, due_at, due_time_zone,
       (SELECT name FROM board_columns WHERE board_columns.id = board_cards.column_id) AS column_name`,
  )
    .bind(claimedAt)
    .all<DueReminder>();
  if (results.length === 0) return { sent: 0 };

  const settings = await env.DB.prepare(
    `SELECT browser_notifications_enabled, browser_board_reminders,
            email_notifications_enabled, email_board_reminders,
            email_notification_address, email_notification_origin
     FROM global_settings WHERE id = 1`,
  ).first<ReminderSettings>();

  for (const reminder of results) {
    await deliverReminder(env, reminder, settings);
  }
  return { sent: results.length };
}

async function deliverReminder(
  env: Env & SendEmailEnv,
  reminder: DueReminder,
  settings: ReminderSettings | null,
): Promise<void> {
  const jobs: Promise<unknown>[] = [];
  // Each kind of notification carries reminders only while it is on and its
  // Board reminders box is checked.
  if (settings?.browser_notifications_enabled && settings.browser_board_reminders) {
    jobs.push(pushToSubscribedBrowsers(env, buildReminderPush(reminder)));
  }
  if (
    settings?.email_notifications_enabled &&
    settings.email_board_reminders &&
    settings.email_notification_address
  ) {
    jobs.push(
      emailReminder(env, reminder, settings.email_notification_address, settings.email_notification_origin),
    );
  }
  const outcomes = await Promise.allSettled(jobs);
  for (const outcome of outcomes) {
    if (outcome.status === "rejected") {
      console.error("Board reminder delivery failed", {
        cardId: reminder.id,
        error: outcome.reason instanceof Error ? outcome.reason.message : "unknown",
      });
    }
  }
}

async function emailReminder(
  env: Env & SendEmailEnv,
  reminder: DueReminder,
  recipient: string,
  origin: string | null,
): Promise<void> {
  // Sent from the Inbox chosen for Email Notifications, else the first Inbox,
  // and never to an Inbox, so a reminder can't arrive back in Mailroom.
  const [inbox, recipientIsInbox] = await Promise.all([
    env.DB.prepare(
      `SELECT address FROM mailboxes
       ORDER BY id = (SELECT email_notification_from_mailbox_id FROM global_settings WHERE id = 1) DESC,
         address
       LIMIT 1`,
    ).first<{ address: string }>(),
    env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(recipient).first(),
  ]);
  if (!inbox || recipientIsInbox) {
    console.log("Board reminder email skipped", {
      cardId: reminder.id,
      reason: inbox ? "internal_address" : "no_inbox",
    });
    return;
  }
  const content = buildReminderEmail(reminder, origin);
  await sendEmail(env, {
    from: { address: inbox.address, name: "Mailroom +" },
    to: [recipient],
    subject: content.subject,
    text: content.text,
    autoSubmitted: "auto-generated",
  });
}

function oneLine(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}
