import { sendEmail, type SendEmailEnv } from "../email/send.ts";

const MAX_ADDRESS_LENGTH = 254;
const ADDRESS_PATTERN = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[^\s@<>()",;:]+$/;

export interface EmailNotificationInput {
  threadId: number;
  inboxAddress: string;
  senderName: string | null;
  senderAddress: string;
  subject: string;
  preview: string;
}

export interface EmailNotificationContent {
  subject: string;
  text: string;
}

/** Normalizes a notification address, or returns null when it is not a plain address. */
export function normalizeNotificationAddress(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const address = value.trim().toLowerCase();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  return ADDRESS_PATTERN.test(address) ? address : null;
}

export function buildEmailNotification(
  input: EmailNotificationInput,
  origin: string | null,
): EmailNotificationContent {
  const sender = oneLine(input.senderName) || oneLine(input.senderAddress) || "Unknown sender";
  const fromLine = input.senderName?.trim() && input.senderAddress.trim()
    ? `${oneLine(input.senderName)} <${oneLine(input.senderAddress)}>`
    : sender;
  const subject = oneLine(input.subject).slice(0, 160) || "(no subject)";
  const preview = input.preview.replace(/\s+/g, " ").trim().slice(0, 500);

  const lines = [
    `${input.inboxAddress} received a new email.`,
    "",
    `From: ${fromLine}`,
    `Subject: ${subject}`,
  ];
  if (preview) lines.push("", preview);
  if (origin) lines.push("", `Open conversation: ${origin.replace(/\/$/, "")}/inbox/${input.threadId}`);
  lines.push("", "You are receiving this because email notifications are on in Mailroom settings.");

  return {
    subject: `New email from ${sender.slice(0, 80)}: ${subject}`,
    text: lines.join("\n"),
  };
}

export async function notifyNewEmailByEmail(
  env: SendEmailEnv & { DB: D1Database },
  input: EmailNotificationInput,
): Promise<void> {
  const settings = await env.DB.prepare(
    `SELECT email_notification_address, email_notification_origin
     FROM global_settings WHERE id = 1`,
  ).first<{ email_notification_address: string | null; email_notification_origin: string | null }>();
  const recipient = settings?.email_notification_address;
  if (!recipient) return;

  // Never notify about mail from the notification address itself or from one
  // of our own Inboxes: an auto-responder or forward would otherwise loop.
  const sender = input.senderAddress.trim().toLowerCase();
  if (sender === recipient) return;
  const internal = await env.DB.prepare(
    "SELECT id FROM mailboxes WHERE address IN (?, ?) LIMIT 1",
  )
    .bind(sender, recipient)
    .first();
  if (internal) return;

  const content = buildEmailNotification(input, settings.email_notification_origin);
  await sendEmail(env, {
    from: { address: input.inboxAddress, name: "Mailroom" },
    to: [recipient],
    subject: content.subject,
    text: content.text,
    autoSubmitted: "auto-generated",
  });
}

function oneLine(value: string | null | undefined): string {
  return (value ?? "").trim().replace(/\s+/g, " ");
}
