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
}

export interface SendEmailEnv {
  EMAIL: {
    send(message: {
      from: string | { email: string; name?: string };
      to: string | Array<string | { email: string; name?: string }>;
      subject: string;
      text?: string;
      html?: string;
      attachments?: OutgoingAttachment[];
      headers?: Record<string, string>;
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

  const result = await env.EMAIL.send({
    from: mail.from.name
      ? { email: mail.from.address, name: mail.from.name }
      : mail.from.address,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    ...(mail.attachments?.length ? { attachments: mail.attachments } : {}),
    headers,
  });

  const messageId = result.messageId.startsWith("<")
    ? result.messageId
    : `<${result.messageId}>`;
  return { messageId };
}
