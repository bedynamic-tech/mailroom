import { sendEmail, type SendEmailEnv } from "../email/send.ts";
import {
  DEFAULT_NOTIFICATION_BODY,
  DEFAULT_NOTIFICATION_FROM_NAME,
  DEFAULT_NOTIFICATION_SUBJECT,
  NOTIFICATION_LIMITS,
  renderNotification,
  unknownPlaceholders,
  type NotificationTemplate,
  type NotificationValues,
} from "../../shared/notification-template.ts";

const MAX_ADDRESS_LENGTH = 254;
const ADDRESS_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export interface EmailNotificationInput {
  threadId: number;
  /** The Message was added to an existing Conversation. */
  isReply?: boolean;
  inboxAddress: string;
  senderName: string | null;
  senderAddress: string;
  subject: string;
  preview: string;
}

export interface EmailNotificationContent {
  fromName: string;
  subject: string;
  text: string;
}

export interface StoredNotificationTemplate {
  email_notification_from_name: string | null;
  email_notification_subject: string | null;
  email_notification_body: string | null;
}

/** Normalizes a notification address, or returns null when it is not a plain address. */
export function normalizeNotificationAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  return ADDRESS_PATTERN.test(address) ? address : null;
}

/** Stored columns with the built-in defaults filled in. */
export function effectiveTemplate(stored: Partial<StoredNotificationTemplate> | null): NotificationTemplate {
  return {
    fromName: stored?.email_notification_from_name ?? DEFAULT_NOTIFICATION_FROM_NAME,
    subject: stored?.email_notification_subject ?? DEFAULT_NOTIFICATION_SUBJECT,
    body: stored?.email_notification_body ?? DEFAULT_NOTIFICATION_BODY,
  };
}

/** Returns an error message for an invalid template, or null when it can be saved. */
export function validateTemplate(template: {
  fromName: unknown;
  subject: unknown;
  body: unknown;
}): string | null {
  const { fromName, subject, body } = template;
  if (typeof fromName !== "string" || typeof subject !== "string" || typeof body !== "string") {
    return "Sender name, subject and body are required";
  }
  if (fromName.length > NOTIFICATION_LIMITS.fromName) {
    return `Sender name must be ${NOTIFICATION_LIMITS.fromName} characters or fewer`;
  }
  if (/[\r\n"<>]/.test(fromName)) return "Sender name can't contain line breaks, quotes or angle brackets";
  if (!subject.trim()) return "Subject can't be empty";
  if (subject.length > NOTIFICATION_LIMITS.subject) {
    return `Subject must be ${NOTIFICATION_LIMITS.subject} characters or fewer`;
  }
  if (!body.trim()) return "Body can't be empty";
  if (body.length > NOTIFICATION_LIMITS.body) {
    return `Body must be ${NOTIFICATION_LIMITS.body} characters or fewer`;
  }
  const unknown = unknownPlaceholders(`${fromName}\n${subject}\n${body}`);
  if (unknown.length > 0) {
    return `Unknown placeholder${unknown.length > 1 ? "s" : ""}: ${unknown.map((key) => `{{${key}}}`).join(", ")}`;
  }
  return null;
}

export function notificationValues(
  input: EmailNotificationInput,
  origin: string | null,
): NotificationValues {
  const oneLine = (value: string | null | undefined) => (value ?? "").trim().replace(/\s+/g, " ");
  const senderEmail = oneLine(input.senderAddress);
  return {
    sender_name: (oneLine(input.senderName) || senderEmail || "Unknown sender").slice(0, 80),
    sender_email: senderEmail || "unknown",
    subject: oneLine(input.subject).slice(0, 160) || "(no subject)",
    preview: input.preview.replace(/\s+/g, " ").trim().slice(0, 500),
    inbox: input.inboxAddress,
    link: origin ? `${origin.replace(/\/$/, "")}/inbox/${input.threadId}` : "",
  };
}

export function buildEmailNotification(
  input: EmailNotificationInput,
  origin: string | null,
  template: NotificationTemplate = effectiveTemplate(null),
): EmailNotificationContent {
  const rendered = renderNotification(template, notificationValues(input, origin));
  return { fromName: rendered.fromName, subject: rendered.subject, text: rendered.body };
}

interface NotificationSettings extends StoredNotificationTemplate {
  email_notifications_enabled: number;
  /** 0 when the New email or Replies box under Email Notifications is unchecked. */
  email_new_email?: number;
  email_replies?: number;
  email_notification_address: string | null;
  email_notification_origin: string | null;
  email_notification_from_mailbox_id: number | null;
}

export type EmailNotificationResult =
  | { status: "sent"; from: string; to: string }
  | { status: "skipped"; reason: "off" | "internal_address" };

async function loadSettings(env: { DB: D1Database }): Promise<NotificationSettings | null> {
  return env.DB.prepare(
    `SELECT email_notifications_enabled, email_new_email, email_replies, email_notification_address, email_notification_origin,
            email_notification_from_name, email_notification_from_mailbox_id,
            email_notification_subject, email_notification_body
     FROM global_settings WHERE id = 1`,
  ).first<NotificationSettings>();
}

export async function notifyNewEmailByEmail(
  env: SendEmailEnv & { DB: D1Database },
  input: EmailNotificationInput,
): Promise<EmailNotificationResult> {
  const settings = await loadSettings(env);
  const recipient = settings?.email_notification_address;
  const typeOff = (input.isReply ? settings?.email_replies : settings?.email_new_email) === 0;
  if (!settings?.email_notifications_enabled || typeOff || !recipient) {
    return { status: "skipped", reason: "off" };
  }

  // Never notify about mail from one of our own Inboxes (or when the recipient
  // is one): the notice would arrive back in Mailroom and loop.
  const sender = input.senderAddress.trim().toLowerCase();
  const internal = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address IN (?, ?) LIMIT 1",
  )
    .bind(sender, recipient)
    .first();
  if (internal) return skipped("internal_address", input);

  return deliver(env, settings, recipient, input);
}

/** Sends a sample notice to the saved address, surfacing any provider error to the caller. */
export async function sendTestEmailNotification(
  env: SendEmailEnv & { DB: D1Database },
): Promise<EmailNotificationResult> {
  const settings = await loadSettings(env);
  const recipient = settings?.email_notification_address;
  if (!settings || !recipient) return { status: "skipped", reason: "off" };

  const inbox = await env.DB.prepare("SELECT address FROM mailboxes ORDER BY address LIMIT 1")
    .first<{ address: string }>();
  if (!inbox) throw new Error("Add an inbox before sending a test notification");

  return deliver(env, settings, recipient, {
    threadId: 0,
    inboxAddress: inbox.address,
    senderName: "Alice Customer",
    senderAddress: "alice@example.com",
    subject: "Test notification from Mailroom +",
    preview: "This is a test of your email notification settings. New emails will look like this.",
  });
}

async function deliver(
  env: SendEmailEnv & { DB: D1Database },
  settings: NotificationSettings,
  recipient: string,
  input: EmailNotificationInput,
): Promise<EmailNotificationResult> {
  // A chosen sending Inbox that was since deleted falls back to the receiving Inbox.
  let fromAddress = input.inboxAddress;
  if (settings.email_notification_from_mailbox_id !== null) {
    const chosen = await env.DB.prepare("SELECT address FROM mailboxes WHERE id = ?")
      .bind(settings.email_notification_from_mailbox_id)
      .first<{ address: string }>();
    if (chosen) fromAddress = chosen.address;
  }

  const content = buildEmailNotification(
    input,
    input.threadId > 0 ? settings.email_notification_origin : null,
    effectiveTemplate(settings),
  );
  await sendEmail(env, {
    from: content.fromName
      ? { address: fromAddress, name: content.fromName }
      : { address: fromAddress },
    to: [recipient],
    subject: content.subject,
    text: content.text,
    autoSubmitted: "auto-generated",
  });
  return { status: "sent", from: fromAddress, to: recipient };
}

function skipped(
  reason: "internal_address",
  input: EmailNotificationInput,
): EmailNotificationResult {
  console.log("Email notification skipped", { threadId: input.threadId, reason });
  return { status: "skipped", reason };
}
