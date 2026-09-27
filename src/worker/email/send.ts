/**
 * Outbound mail via Cloudflare Email Sending (send_email binding).
 * Callers only see this interface, so swapping providers (e.g. Resend)
 * means reimplementing this one function.
 */
/** Matches the `attachments` entries accepted by the send_email binding. */
export interface OutgoingAttachment {
  /** Raw text or binary content (never base64 on the Workers binding). */
  content: string | ArrayBuffer | ArrayBufferView;
  filename: string;
  type: string;
  disposition: "attachment" | "inline";
  contentId?: string;
}

export interface OutgoingEmail {
  from: { address: string; name?: string };
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  text: string;
  attachments?: OutgoingAttachment[];
  /** RFC Message-ID of the message being replied to */
  inReplyTo?: string;
  /** Full References chain, oldest first */
  references?: string[];
  /** Set for agent-sent mail so recipients' auto-responders stay quiet (RFC 3834) */
  autoSubmitted?: "auto-replied" | "auto-generated";
  /** Durable send-attempt id for tracing an ambiguous send in provider logs. */
  attemptId?: string;
  /** Where recipients' replies go instead of the From address. */
  replyTo?: string;
  /** The Mail Rule that forwarded this email; inbound copies carrying it are never forwarded again. */
  forwardedByRule?: number;
}

/** Marks email a Mail Rule forwarded, so a copy arriving back is not forwarded again. */
export const FORWARD_HEADER = "X-Mailroom-Forward";

export interface SendEmailEnv {
  EMAIL: {
    send(message: {
      from: string | { email: string; name?: string };
      to: string | Array<string | { email: string; name?: string }>;
      cc?: string | Array<string | { email: string; name?: string }>;
      bcc?: string | Array<string | { email: string; name?: string }>;
      subject: string;
      text?: string;
      html?: string;
      attachments?: OutgoingAttachment[];
      headers?: Record<string, string>;
      replyTo?: string;
    }): Promise<{ messageId: string }>;
  };
}

export interface SendResult {
  /**
   * Message-ID assigned by Cloudflare (it cannot be set manually), stored so
   * future inbound replies can be matched back to this thread via References.
   */
  messageId: string;
}

export async function sendEmail(env: SendEmailEnv, mail: OutgoingEmail): Promise<SendResult> {
  const headers: Record<string, string> = {};
  if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
  if (mail.references?.length) headers["References"] = mail.references.join(" ");
  if (mail.autoSubmitted) headers["Auto-Submitted"] = mail.autoSubmitted;
  if (mail.attemptId) headers["X-Mailroom-Attempt"] = mail.attemptId;
  if (mail.forwardedByRule !== undefined) headers[FORWARD_HEADER] = String(mail.forwardedByRule);

  if (!env.EMAIL) throw new Error("Email sending isn't configured for this deployment");
  const result = await env.EMAIL.send({
    from: mail.from.name
      ? { email: mail.from.address, name: mail.from.name }
      : mail.from.address,
    to: mail.to,
    ...(mail.cc?.length ? { cc: mail.cc } : {}),
    ...(mail.bcc?.length ? { bcc: mail.bcc } : {}),
    subject: mail.subject,
    text: mail.text,
    ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
    ...(mail.replyTo ? { replyTo: mail.replyTo } : {}),
    headers,
  });

  const messageId = result.messageId.startsWith("<")
    ? result.messageId
    : `<${result.messageId}>`;
  return { messageId };
}
