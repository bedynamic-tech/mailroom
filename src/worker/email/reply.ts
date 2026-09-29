import type { ReplyAttemptResult } from "../../shared/types";
import { MAX_RECIPIENTS_PER_MESSAGE } from "../../shared/email-limits.ts";
import { dedupeRecipients, normalizeEmailAddress } from "../../shared/recipients.ts";
import {
  attachmentFingerprint,
  normalizeAttachments,
  parseStagedAttachments,
  recordAttachmentStatements,
  sendableAttachments,
  stageAttachments,
  type NormalizedAttachment,
  type OutboundAttachmentInput,
  type StagedAttachment,
} from "./attachments.ts";
import { sendEmail, type SendEmailEnv } from "./send.ts";
import { normalizeSenderName, senderFrom } from "../../shared/sender-name.ts";
import { composeOutgoingBodies, effectiveSignature } from "../../shared/signature.ts";
import { normalizeMessageBody } from "../../shared/rich-text.ts";
import { claimDailySendBudget } from "./send-budget.ts";

export interface ReplyEnv extends SendEmailEnv {
  DB: D1Database;
  RAW: R2Bucket;
}

export interface ReplyIntent {
  attemptId: string;
  threadId: number;
  text: string;
  /** Rich-text body; when set, `text` is derived from it. */
  html?: string | null;
  /** To recipients chosen in the composer; when omitted, To is the latest inbound reply target. */
  to?: string[];
  /** Extra Cc/Bcc recipients. */
  cc?: string[];
  bcc?: string[];
  attachments?: OutboundAttachmentInput[];
  draftId?: number;
  sentBy?: "human" | "agent";
  actorId?: string;
  oauthClientId?: string;
  inboundMessageId?: number;
  expectedRecipients?: string[];
  dailySendLimit?: number;
}

interface StoredAttempt {
  id: string;
  thread_id: number;
  inbound_message_id: number;
  draft_id: number | null;
  status: "pending" | "sending" | "sent" | "failed";
  text_body: string;
  to_addresses: string;
  cc_addresses?: string;
  bcc_addresses?: string;
  attachments: string;
  message_id: string | null;
  error: string | null;
  sent_by?: "human" | "agent";
  actor_id?: string | null;
  oauth_client_id?: string | null;
  signature_html?: string | null;
  html_body?: string | null;
}

export async function sendReplyAttempt(
  env: ReplyEnv,
  requested: ReplyIntent,
): Promise<ReplyAttemptResult> {
  const body = normalizeMessageBody(requested.text, requested.html);
  const intent: ReplyIntent = { ...requested, text: body.text, html: body.html };
  const attachments = normalizeAttachments(intent.attachments ?? []);
  if (!intent.text.trim() && attachments.length === 0) {
    throw new ReplyIntentError("Reply text is required", 400);
  }
  const existing = await getAttempt(env, intent.attemptId);
  if (existing) {
    existingResult(existing, intent, attachments);
    if (existing.status === "sent" || existing.status === "failed") {
      return existingResult(existing, intent, attachments);
    }
    if (existing.status === "sending" && !existing.message_id) {
      return existingResult(existing, intent, attachments);
    }
  }

  // A caught Conversation replies from the address it was sent to.
  const thread = await env.DB.prepare(
    `SELECT t.id, t.mailbox_id, t.subject,
       COALESCE(t.catch_all_recipient, m.address) AS mailbox_address,
       m.display_name AS mailbox_display_name,
       m.signature_mode AS mailbox_signature_mode,
       m.signature_html AS mailbox_signature_html,
       (SELECT default_signature_html FROM global_settings WHERE id = 1) AS default_signature_html
     FROM threads t JOIN mailboxes m ON m.id = t.mailbox_id WHERE t.id = ?`,
  )
    .bind(intent.threadId)
    .first<{
      id: number;
      mailbox_id: number;
      subject: string;
      mailbox_address: string;
      mailbox_display_name?: string | null;
      mailbox_signature_mode?: string | null;
      mailbox_signature_html?: string | null;
      default_signature_html?: string | null;
    }>();
  if (!thread) throw new ReplyIntentError("Conversation not found", 404);
  // A retry keeps the signature the attempt was created with.
  const signatureHtml = existing
    ? existing.signature_html ?? null
    : effectiveSignature(
        thread.mailbox_signature_mode,
        thread.mailbox_signature_html,
        thread.default_signature_html,
      );

  let lastInbound = await env.DB.prepare(
    `SELECT id, message_id, from_address, reply_to_addresses, references_ids
     FROM messages
     WHERE thread_id = ? AND direction = 'inbound'
       AND (? = 0 OR id = ?)
       AND (? = 0 OR id = (
         SELECT latest.id FROM messages latest
         WHERE latest.thread_id = ? AND latest.direction = 'inbound'
         ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
       ))
     ORDER BY created_at DESC, id DESC LIMIT 1`,
  )
    .bind(
      intent.threadId,
      existing?.inbound_message_id ?? intent.inboundMessageId ?? 0,
      existing?.inbound_message_id ?? intent.inboundMessageId ?? 0,
      existing ? 0 : intent.inboundMessageId ?? 0,
      intent.threadId,
    )
    .first<{
      id: number;
      message_id: string;
      from_address: string;
      reply_to_addresses: string;
      references_ids: string;
      to_addresses?: string;
    }>();
  if (!lastInbound && !existing && intent.inboundMessageId !== undefined) {
    throw new ReplyIntentError(
      "Conversation advanced after it was read; read it again before replying",
      409,
    );
  }
  // A Conversation started from Mailroom has no inbound Message until someone answers,
  // so a follow-up threads on the latest sent Message and goes to its To recipients.
  const followsUpSent = !lastInbound;
  if (!lastInbound) {
    lastInbound = await env.DB.prepare(
      `SELECT id, message_id, from_address, reply_to_addresses, references_ids, to_addresses
       FROM messages
       WHERE thread_id = ? AND direction = 'outbound' AND (? = 0 OR id = ?)
       ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(
        intent.threadId,
        existing?.inbound_message_id ?? 0,
        existing?.inbound_message_id ?? 0,
      )
      .first();
  }
  if (!lastInbound) throw new ReplyIntentError("No message to reply to", 400);

  const replyTarget = followsUpSent
    ? parseAddresses(lastInbound.to_addresses ?? "[]")
    : parseAddresses(lastInbound.reply_to_addresses);
  if (replyTarget.length === 0 && !followsUpSent) replyTarget.push(lastInbound.from_address);
  // Retries keep the stored To; a new attempt uses the composer's To when it chose one.
  const recipients = existing
    ? parseAddresses(existing.to_addresses)
    : chosenRecipients(intent) ?? replyTarget;
  if (recipients.length === 0) {
    throw new ReplyIntentError("Reply needs at least one To recipient", 400);
  }
  if (recipients.length > 20) {
    throw new ReplyIntentError("Reply has too many recipients", 400);
  }
  // Retries reuse the stored copies so a reviewed attempt keeps its audience.
  const copies = existing
    ? { cc: parseAddresses(existing.cc_addresses ?? "[]"), bcc: parseAddresses(existing.bcc_addresses ?? "[]") }
    : copyRecipients(recipients, intent);
  if (recipients.length + copies.cc.length + copies.bcc.length > MAX_RECIPIENTS_PER_MESSAGE) {
    throw new ReplyIntentError(
      `Reply can have at most ${MAX_RECIPIENTS_PER_MESSAGE} recipients`,
      400,
    );
  }
  if (
    intent.expectedRecipients &&
    !sameAddresses(replyTarget, intent.expectedRecipients)
  ) {
    throw new ReplyIntentError(
      "Reply recipient changed after it was reviewed; read the Conversation again",
      409,
    );
  }

  let staged: StagedAttachment[] = existing
    ? parseStagedAttachments(existing.attachments)
    : [];

  if (!existing) {
    try {
      staged = await stageAttachments(
        env.RAW,
        thread.mailbox_id,
        intent.attemptId,
        attachments,
      );
      await env.DB.prepare(
        `INSERT INTO reply_attempts
           (id, thread_id, inbound_message_id, draft_id, status, text_body, to_addresses,
            attachments, sent_by, actor_id, oauth_client_id, cc_addresses, bcc_addresses,
            signature_html, html_body)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(
          intent.attemptId,
          intent.threadId,
          lastInbound.id,
          intent.draftId ?? null,
          intent.text.trim(),
          JSON.stringify(recipients),
          JSON.stringify(staged),
          intent.sentBy ?? (intent.draftId ? "agent" : "human"),
          intent.actorId ?? null,
          intent.oauthClientId ?? null,
          JSON.stringify(copies.cc),
          JSON.stringify(copies.bcc),
          signatureHtml,
          body.html,
        )
        .run();
      if (
        intent.actorId &&
        intent.dailySendLimit !== undefined &&
        !(await claimDailySendBudget(env, intent.actorId, intent.dailySendLimit))
      ) {
        await env.DB.prepare(
          `UPDATE reply_attempts
           SET status = 'failed', error = 'Daily MCP send limit reached',
               updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE id = ?`,
        )
          .bind(intent.attemptId)
          .run();
        throw new ReplyIntentError("Daily MCP send limit reached", 429);
      }
    } catch (error) {
      if (error instanceof ReplyIntentError) throw error;
      const raced = await getAttempt(env, intent.attemptId);
      if (raced) return existingResult(raced, intent, attachments);
      throw error;
    }
  }

  if (!existing || existing.status === "pending") {
    const claimed = await env.DB.prepare(
      `UPDATE reply_attempts
       SET status = 'sending', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
       WHERE id = ? AND status = 'pending' RETURNING id`,
    )
      .bind(intent.attemptId)
      .first<{ id: string }>();
    if (!claimed) {
      const raced = await getAttempt(env, intent.attemptId);
      if (!raced) throw new ReplyIntentError("Reply Attempt disappeared", 500);
      return existingResult(raced, intent, attachments);
    }
  }

  const references = boundedReferences([
    ...parseAddresses(lastInbound.references_ids),
    lastInbound.message_id,
  ]);
  const subject = /^re:/i.test(thread.subject) ? thread.subject : `Re: ${thread.subject}`;
  const bodies = composeOutgoingBodies(body, signatureHtml);

  let messageId = existing?.message_id ?? null;
  if (!messageId) {
    try {
      ({ messageId } = await sendEmail(env, {
        from: senderFrom(thread.mailbox_address, thread.mailbox_display_name),
        to: recipients,
        cc: copies.cc,
        bcc: copies.bcc,
        subject,
        text: bodies.text,
        html: bodies.html,
        attachments: sendableAttachments(attachments),
        inReplyTo: lastInbound.message_id,
        references,
        autoSubmitted:
          (intent.sentBy ?? (intent.draftId ? "agent" : "human")) === "agent"
            ? "auto-replied"
            : undefined,
        attemptId: intent.attemptId,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Email provider rejected the reply";
      await env.DB.prepare(
        `UPDATE reply_attempts
         SET status = 'failed', error = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ?`,
      )
        .bind(message.slice(0, 2000), intent.attemptId)
        .run();
      return {
        ok: false,
        attempt_id: intent.attemptId,
        status: "failed",
        message_id: null,
        error: message,
      };
    }
    try {
      await env.DB.prepare(
        `UPDATE reply_attempts
         SET message_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
         WHERE id = ? AND status = 'sending'`,
      )
        .bind(messageId, intent.attemptId)
        .run();
    } catch {
      console.error("Could not checkpoint provider result for Reply Attempt", {
        attemptId: intent.attemptId,
      });
    }
  }

  const now = new Date().toISOString();
  const snippet =
    intent.text.replace(/\s+/g, " ").trim().slice(0, 140) ||
    staged
      .map((attachment) => attachment.filename ?? "attachment")
      .join(", ")
      .slice(0, 140);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO messages
         (thread_id, message_id, in_reply_to, references_ids, direction, sent_by,
          from_address, from_name, to_addresses, reply_to_addresses,
          subject, text_body, created_at, cc_addresses, bcc_addresses, html_body)
       VALUES (?, ?, ?, ?, 'outbound', ?, ?, ?, ?, '[]', ?, ?, ?, ?, ?, ?)`,
    ).bind(
      intent.threadId,
      messageId,
      lastInbound.message_id,
      JSON.stringify(references),
      intent.sentBy ?? (intent.draftId ? "agent" : "human"),
      thread.mailbox_address,
      normalizeSenderName(thread.mailbox_display_name) || null,
      JSON.stringify(recipients),
      subject,
      bodies.text,
      now,
      JSON.stringify(copies.cc),
      JSON.stringify(copies.bcc),
      bodies.html ?? null,
    ),
    ...recordAttachmentStatements(env.DB, staged, messageId),
    env.DB.prepare(
      `UPDATE threads
       SET snippet = ?, message_count = message_count + 1, last_message_at = ?, is_read = 1
       WHERE id = ?`,
    ).bind(snippet, now, intent.threadId),
    env.DB.prepare(
      `UPDATE reply_attempts
       SET status = 'sent', message_id = ?, error = NULL, updated_at = ?
       WHERE id = ?`,
    ).bind(messageId, now, intent.attemptId),
  ];
  if (intent.draftId) {
    statements.push(
      env.DB.prepare(
        "UPDATE drafts SET status = 'sent' WHERE id = ? AND thread_id = ?",
      ).bind(intent.draftId, intent.threadId),
    );
  }
  await env.DB.batch(statements);

  return {
    ok: true,
    attempt_id: intent.attemptId,
    status: "sent",
    message_id: messageId,
  };
}

async function getAttempt(env: ReplyEnv, id: string): Promise<StoredAttempt | null> {
  return env.DB.prepare("SELECT * FROM reply_attempts WHERE id = ?")
    .bind(id)
    .first<StoredAttempt>();
}

function existingResult(
  existing: StoredAttempt,
  intent: ReplyIntent,
  attachments: NormalizedAttachment[],
): ReplyAttemptResult {
  const sentBy = intent.sentBy ?? (intent.draftId ? "agent" : "human");
  if (
    existing.thread_id !== intent.threadId ||
    existing.text_body !== intent.text.trim() ||
    (existing.html_body ?? null) !== (intent.html ?? null) ||
    existing.draft_id !== (intent.draftId ?? null) ||
    !sameCopies(existing, intent) ||
    (intent.to !== undefined &&
      !sameAddresses(parseAddresses(existing.to_addresses), chosenRecipients(intent) ?? [])) ||
    attachmentFingerprint(parseStagedAttachments(existing.attachments)) !==
      attachmentFingerprint(attachments) ||
    (intent.inboundMessageId !== undefined &&
      existing.inbound_message_id !== intent.inboundMessageId) ||
    (intent.expectedRecipients !== undefined &&
      !sameAddresses(parseAddresses(existing.to_addresses), intent.expectedRecipients)) ||
    (existing.sent_by ?? "human") !== sentBy ||
    (existing.actor_id ?? null) !== (intent.actorId ?? null) ||
    (existing.oauth_client_id ?? null) !== (intent.oauthClientId ?? null)
  ) {
    throw new ReplyIntentError("Reply Attempt id was already used for different content", 409);
  }
  return {
    ok: existing.status === "sent",
    attempt_id: existing.id,
    status: existing.status,
    message_id: existing.message_id,
    ...(existing.error ? { error: existing.error } : {}),
  };
}

function parseAddresses(raw: string): string[] {
  try {
    const values = JSON.parse(raw) as unknown;
    return Array.isArray(values)
      ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))]
      : [];
  } catch {
    return [];
  }
}

/** The composer's To list, normalized and deduplicated, or null when it chose none. */
function chosenRecipients(intent: ReplyIntent): string[] | null {
  if (intent.to === undefined) return null;
  const seen = new Set<string>();
  const to: string[] = [];
  for (const raw of intent.to) {
    const address = normalizeEmailAddress(raw);
    const key = address.toLowerCase();
    if (!address || seen.has(key)) continue;
    seen.add(key);
    to.push(address);
  }
  return to;
}

function copyRecipients(to: string[], intent: ReplyIntent): { cc: string[]; bcc: string[] } {
  const { cc, bcc } = dedupeRecipients({
    to,
    cc: (intent.cc ?? []).map(normalizeEmailAddress),
    bcc: (intent.bcc ?? []).map(normalizeEmailAddress),
  });
  return { cc, bcc };
}

function sameCopies(existing: StoredAttempt, intent: ReplyIntent): boolean {
  const copies = copyRecipients(parseAddresses(existing.to_addresses), intent);
  return (
    sameAddresses(parseAddresses(existing.cc_addresses ?? "[]"), copies.cc) &&
    sameAddresses(parseAddresses(existing.bcc_addresses ?? "[]"), copies.bcc)
  );
}

function sameAddresses(actual: string[], expected: string[]): boolean {
  const normalize = (values: string[]) =>
    [...new Set(values.map((value) => value.trim().toLowerCase()).filter(Boolean))].sort();
  const left = normalize(actual);
  const right = normalize(expected);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function boundedReferences(values: string[]): string[] {
  const unique = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  const kept: string[] = [];
  let bytes = 0;
  for (const value of unique.reverse()) {
    const size = new TextEncoder().encode(value).byteLength + (kept.length ? 1 : 0);
    if (size > 1900) continue;
    if (bytes + size > 1900 || kept.length >= 40) break;
    kept.unshift(value);
    bytes += size;
  }
  return kept;
}

export class ReplyIntentError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
