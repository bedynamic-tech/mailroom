/**
 * Cloudflare Email Sending sends mail with its own bounce address, so bounce
 * notices from receiving servers go to Cloudflare, not back to the Inbox.
 * Cloudflare publishes what happened to each recipient as Email Sending
 * events on a queue subscription; the bounced, rejected and failed ones are
 * recorded here as Bounces on the outbound Message they are about.
 */

export const SENDING_EVENT_PREFIX = "cf.email.sending.";

/** The fields Mailroom reads from an Email Sending event. */
export interface EmailSendingEvent {
  type: string;
  payload?: {
    messageId?: string;
    sender?: string;
    recipient?: string;
    subject?: string;
    terminal?: boolean;
    delivery?: {
      status?: string;
      smtpEnhancedStatusCode?: string;
      smtpResponse?: string;
    };
    bounce?: { type?: string; reason?: string };
    rejection?: { reason?: string; detail?: string };
    failure?: { reason?: string; detail?: string };
  };
}

const UNDELIVERED = new Set(["message.bounced", "message.rejected", "message.failed"]);
const DIAGNOSTIC_LIMIT = 500;

export function isEmailSendingEvent(body: unknown): body is EmailSendingEvent {
  return typeof body === "object" && body !== null
    && typeof (body as { type?: unknown }).type === "string"
    && (body as { type: string }).type.startsWith(SENDING_EVENT_PREFIX);
}

/**
 * Records a Bounce for an undelivered recipient. Returns false when the event
 * is not about an undelivered recipient of a Message Mailroom sent, which is
 * normal (delivered events, or mail sent by something else on the domain).
 */
export async function recordSendingEvent(env: Pick<Env, "DB">, event: EmailSendingEvent): Promise<boolean> {
  const kind = event.type.slice(SENDING_EVENT_PREFIX.length);
  const payload = event.payload;
  if (!UNDELIVERED.has(kind) || !payload || payload.terminal === false) return false;
  const recipient = addressIn(payload.recipient);
  if (!recipient) return false;

  const messageId = await findSentMessage(env, payload, recipient);
  if (messageId === null) return false;

  const status = payload.delivery?.smtpEnhancedStatusCode?.match(/^\d\.\d{1,3}\.\d{1,3}$/)?.[0] ?? null;
  const diagnostic = clean(
    payload.bounce?.reason
      || payload.delivery?.smtpResponse
      || payload.rejection?.detail
      || payload.failure?.detail
      || payload.failure?.reason
      || "",
  );
  await env.DB.prepare(
    `INSERT INTO message_bounces (message_id, recipient, status, diagnostic, bounce_message_id)
     VALUES (?, ?, ?, ?, NULL)
     ON CONFLICT (message_id, recipient) DO NOTHING`,
  )
    .bind(messageId, recipient, status, diagnostic)
    .run();
  return true;
}

async function findSentMessage(
  env: Pick<Env, "DB">,
  payload: NonNullable<EmailSendingEvent["payload"]>,
  recipient: string,
): Promise<number | null> {
  // Mailroom stores the Message-ID the send returned, wrapped in angle brackets.
  const id = payload.messageId?.trim().replace(/^<|>$/g, "");
  if (id) {
    const byId = await env.DB.prepare(
      `SELECT id FROM messages
       WHERE direction = 'outbound'
         AND (message_id = ?1 OR message_id = ?2 OR substr(message_id, 1, length(?3)) = ?3)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(`<${id}>`, id, `<${id}@`)
      .first<{ id: number }>();
    if (byId) return byId.id;
  }

  // Otherwise the latest email from that sender to that recipient, with the
  // same subject when the event names one, sent in the last three days.
  const sender = addressIn(payload.sender);
  if (!sender) return null;
  const subject = payload.subject ?? null;
  const bySender = await env.DB.prepare(
    `SELECT m.id FROM messages m
     WHERE m.direction = 'outbound' AND lower(m.from_address) = ?1
       AND (?3 IS NULL OR m.subject = ?3)
       AND m.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-3 days')
       AND EXISTS (
         SELECT 1 FROM json_each(m.to_addresses) r WHERE lower(r.value) = ?2
         UNION ALL
         SELECT 1 FROM json_each(m.cc_addresses) r WHERE lower(r.value) = ?2
         UNION ALL
         SELECT 1 FROM json_each(m.bcc_addresses) r WHERE lower(r.value) = ?2
       )
     ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
  )
    .bind(sender, recipient, subject)
    .first<{ id: number }>();
  return bySender?.id ?? null;
}

/** "Jane <Jane@Example.com>" becomes "jane@example.com". */
function addressIn(value: string | undefined): string | null {
  if (!value) return null;
  const address = (value.match(/<([^<>]+)>/)?.[1] ?? value).trim().toLowerCase();
  return address.includes("@") ? address : null;
}

function clean(value: string): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…` : text;
}
