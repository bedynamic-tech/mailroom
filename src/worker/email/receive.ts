import PostalMime, { type Address, type Attachment, type Email } from "postal-mime";
import { enqueueDraftRun } from "../agent/runs";
import { splitQuotedTail } from "../../shared/quote";
import { labelNewThread } from "./label";
import { recordSender } from "../contacts/contacts";
import { notifyNewEmail } from "../notifications/push";
import { notifyNewEmailByEmail } from "../notifications/email";
import { matchBlockedSender } from "../spam/blocklist";
import { resolveInboundTarget } from "../inbox/catch-all";
import { applyMailRules, deletingMailRules, matchingMailRules, NO_MAIL_RULES } from "./mail-rules";
import type { MailRuleAddress, MailRuleSubject } from "../../shared/mail-rules";
import { sendRuleForward, type ForwardedOriginal } from "./rule-forward";
import { FORWARD_HEADER } from "./send";
import { matchBounce, parseBounce, recordBounces, type MatchedBounce } from "./bounce";
import {
  addressOf,
  addressesOf,
  attachmentBytes,
  hasReplyPrefix,
  isAutoSubmitted,
  normalizeSubject,
  rawFingerprint,
  replyRecipients,
} from "./rules";

export async function receiveEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const target = await resolveInboundTarget(env, message.to);
  if (target.kind === "unknown") {
    message.setReject("Inbox not configured");
    return;
  }
  if (target.kind === "blocked") {
    console.log("Rejected catch-all mail to a blocked address", { ruleId: target.ruleId });
    message.setReject("Address blocked by recipient");
    return;
  }
  const { mailbox, catchAllRecipient } = target;

  // Blocked Senders are rejected before anything is stored, whether the rule
  // matches the envelope sender or the From header people see in the app.
  if (await rejectIfBlocked(env, mailbox.id, message, [message.from])) return;

  const rawBuffer = await new Response(message.raw).arrayBuffer();
  const fingerprint = await rawFingerprint(rawBuffer);
  const parsed = await PostalMime.parse(rawBuffer);
  if (await rejectIfBlocked(env, mailbox.id, message, [addressOf(parsed.from)])) return;
  const messageId = parsed.messageId ?? `<raw-${fingerprint}@mailroom.invalid>`;

  // A rule that permanently deletes drops the email here, before anything of
  // it is stored. It is accepted rather than rejected, so the sender sees no
  // bounce. If the rules can't be read, the email is kept.
  const deletedBy = await deletingMailRules(env, mailbox.id, ruleSubject(parsed)).catch((error) => {
    console.error("Checking delete rules failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  });
  if (deletedBy.length > 0) {
    console.log("Permanently deleted an email by rule", { ruleIds: deletedBy });
    return;
  }

  const duplicate = await env.DB.prepare(
    `SELECT msg.id, msg.thread_id, msg.is_auto_submitted
     FROM messages msg WHERE msg.message_id = ?`,
  )
    .bind(messageId)
    .first<{ id: number; thread_id: number; is_auto_submitted: number }>();
  if (duplicate) {
    if (mailbox.agent_mode !== "off" && !duplicate.is_auto_submitted && !parseBounce(parsed)) {
      // Rules were applied on first delivery; only honour their draft skip here.
      const rules = await matchingMailRules(env, mailbox.id, ruleSubject(parsed));
      if (!rules.some((rule) => rule.skip_draft)) {
        await enqueueIfExternal(env, duplicate.thread_id, duplicate.id, parsed);
      }
    }
    return;
  }

  const rawKey = `raw/${mailbox.id}/${fingerprint}.eml`;
  await env.RAW.put(rawKey, rawBuffer, {
    httpMetadata: { contentType: "message/rfc822" },
  });

  const subject = parsed.subject ?? "";
  const textBody = parsed.text ?? htmlToText(parsed.html ?? "");
  const referencesIds = extractMessageIds(parsed);
  const sender = addressOf(parsed.from);
  // A bounce notice marks the recipients that failed on the sent Message. It
  // is still stored as mail, threaded like any other email.
  const bounce = await findBounce(env, mailbox.id, parsed);
  const existingThreadId = await resolveThread(
    env,
    mailbox.id,
    subject,
    referencesIds,
    sender,
    catchAllRecipient,
  );
  const now = new Date().toISOString();
  const snippet = splitQuotedTail(textBody).main.replace(/\s+/g, " ").trim().slice(0, 140);

  const stored = existingThreadId === null
    ? await storeNewConversation(env, {
        mailboxId: mailbox.id,
        catchAllRecipient,
        messageId,
        parsed,
        subject,
        textBody,
        rawKey,
        snippet,
        now,
      })
    : await appendToConversation(env, {
        threadId: existingThreadId,
        messageId,
        parsed,
        subject,
        textBody,
        rawKey,
        snippet,
        now,
      });

  await storeAttachments(env, mailbox.id, stored.messageId, parsed.attachments);

  if (bounce) {
    await recordBounces(env, bounce, stored.messageId).catch((error) =>
      console.error("Recording bounce failed", {
        messageId: bounce.messageId,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  }

  const rules = await applyMailRules(env, {
    mailboxId: mailbox.id,
    threadId: stored.threadId,
    message: ruleSubject(parsed),
  }).catch((error) => {
    // A broken rule must never bounce or lose mail that is already stored.
    console.error("Mail rules failed", {
      threadId: stored.threadId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NO_MAIL_RULES;
  });

  if (rules.forwards.length > 0) {
    // A copy of one of our own forwards is never forwarded again, so two
    // rules (or a rule and an outside auto-forward) can't loop.
    if (hasHeader(parsed, FORWARD_HEADER)) {
      console.log("Skipped forwarding an email a rule already forwarded", { threadId: stored.threadId });
    } else {
      const original = forwardedOriginal(parsed);
      for (const forward of rules.forwards) {
        ctx.waitUntil(
          sendRuleForward(env, {
            forward,
            mailboxId: mailbox.id,
            messageId: stored.messageId,
            original,
          }).catch((error) =>
            console.error("Rule forward task failed", {
              ruleId: forward.ruleId,
              error: error instanceof Error ? error.message : String(error),
            }),
          ),
        );
      }
    }
  }

  if (sender && !bounce && !isAutoSubmitted(parsed)) {
    ctx.waitUntil(
      recordSender(env, {
        address: sender,
        name: parsed.from && "name" in parsed.from ? parsed.from.name : null,
        seenAt: now,
      }).catch((error) =>
        console.error("Contact update failed", {
          threadId: stored.threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }

  if (existingThreadId === null) {
    ctx.waitUntil(
      labelNewThread(env, stored.threadId, stored.messageId).catch((error) => {
        console.error("Auto-label task failed", {
          threadId: stored.threadId,
          messageId: stored.messageId,
          error: error instanceof Error ? error.message : String(error),
        });
      }),
    );
  }

  if (!rules.skipNotifications) {
    ctx.waitUntil(
      notifyNewEmail(env, {
        threadId: stored.threadId,
        isReply: existingThreadId !== null,
        senderName: parsed.from && "name" in parsed.from ? parsed.from.name : null,
        senderAddress: sender || "unknown",
        subject,
      }).catch((error) => console.error("Browser notification task failed", error)),
    );

    ctx.waitUntil(
      notifyNewEmailByEmail(env, {
        threadId: stored.threadId,
        isReply: existingThreadId !== null,
        inboxAddress: mailbox.address,
        senderName: parsed.from && "name" in parsed.from ? parsed.from.name : null,
        senderAddress: sender,
        subject,
        preview: snippet,
      }).catch((error) =>
        console.error("Email notification task failed", {
          threadId: stored.threadId,
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    );
  }

  if (mailbox.agent_mode !== "off" && !rules.skipDraft && !bounce && !isAutoSubmitted(parsed)) {
    await enqueueIfExternal(env, stored.threadId, stored.messageId, parsed);
  }
}

async function findBounce(env: Env, mailboxId: number, parsed: Email): Promise<MatchedBounce | null> {
  const report = parseBounce(parsed);
  if (!report) return null;
  // Bounce detection must never lose the notice itself.
  return matchBounce(env, mailboxId, report).catch((error) => {
    console.error("Bounce matching failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  });
}

function ruleSubject(parsed: Email): MailRuleSubject {
  return {
    from: mailboxOf(parsed.from),
    to: mailboxesOf(parsed.to),
    cc: mailboxesOf(parsed.cc),
    subject: parsed.subject ?? "",
    body: parsed.text ?? htmlToText(parsed.html ?? ""),
    attachmentNames: sentAttachments(parsed).map((item) => item.filename ?? ""),
  };
}

// Inline resources such as signature logos are not attachments people sent.
function sentAttachments(parsed: Email): Attachment[] {
  return parsed.attachments.filter((item) => item.disposition !== "inline");
}

function forwardedOriginal(parsed: Email): ForwardedOriginal {
  return {
    from: mailboxOf(parsed.from),
    replyTo: replyRecipients(parsed)[0] ?? null,
    to: mailboxesOf(parsed.to),
    cc: mailboxesOf(parsed.cc),
    date: parsed.date ?? null,
    subject: parsed.subject ?? "",
    text: parsed.text ?? htmlToText(parsed.html ?? ""),
    attachments: sentAttachments(parsed),
  };
}

function mailboxOf(address: Address | undefined): MailRuleAddress {
  return {
    address: addressOf(address),
    name: address && "name" in address && address.name ? address.name : null,
  };
}

function mailboxesOf(addresses: Address[] | undefined): MailRuleAddress[] {
  return (addresses ?? []).flatMap((entry) =>
    "group" in entry && entry.group ? entry.group.map(mailboxOf) : [mailboxOf(entry)],
  ).filter((entry) => entry.address);
}

function hasHeader(parsed: Email, name: string): boolean {
  const key = name.toLowerCase();
  return (parsed.headers ?? []).some((header) => header.key.toLowerCase() === key);
}

async function rejectIfBlocked(
  env: Env,
  mailboxId: number,
  message: ForwardableEmailMessage,
  senders: string[],
): Promise<boolean> {
  const rule = await matchBlockedSender(env, mailboxId, senders);
  if (!rule) return false;
  console.log("Rejected mail from blocked sender", { ruleId: rule.id, kind: rule.kind, mailboxId });
  message.setReject("Sender blocked by recipient");
  return true;
}

async function enqueueIfExternal(
  env: Env,
  threadId: number,
  inboundMessageId: number,
  parsed: Email,
): Promise<void> {
  const sender = addressOf(parsed.from);
  if (!sender) return;
  const fromOurAddress = await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?")
    .bind(sender)
    .first();
  if (!fromOurAddress) await enqueueDraftRun(env, threadId, inboundMessageId);
}

async function resolveThread(
  env: Env,
  mailboxId: number,
  subject: string,
  referencesIds: string[],
  sender: string,
  catchAllRecipient: string | null,
): Promise<number | null> {
  if (referencesIds.length > 0) {
    const placeholders = referencesIds.map(() => "?").join(", ");
    const byHeader = await env.DB.prepare(
      `SELECT msg.thread_id AS id FROM messages msg
       JOIN threads t ON t.id = msg.thread_id
       WHERE t.mailbox_id = ? AND msg.message_id IN (${placeholders})
       ORDER BY msg.created_at DESC LIMIT 1`,
    )
      .bind(mailboxId, ...referencesIds)
      .first<{ id: number }>();
    if (byHeader) return byHeader.id;
  }

  const normalized = normalizeSubject(subject);
  if (!normalized || !sender || !hasReplyPrefix(subject)) return null;
  const bySubjectAndSender = await env.DB.prepare(
    `SELECT t.id FROM threads t
     WHERE t.mailbox_id = ? AND t.normalized_subject = ?
       AND t.catch_all_recipient IS ?
       AND t.last_message_at > datetime('now', '-2 days')
       AND EXISTS (
         SELECT 1 FROM messages msg
         WHERE msg.thread_id = t.id AND msg.direction = 'inbound'
           AND lower(msg.from_address) = ?
       )
     ORDER BY t.last_message_at DESC LIMIT 1`,
  )
    .bind(mailboxId, normalized, catchAllRecipient, sender)
    .first<{ id: number }>();
  return bySubjectAndSender?.id ?? null;
}

async function appendToConversation(
  env: Env,
  args: StoredMessageInput & { threadId: number; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const results = await env.DB.batch([
    insertMessage(env, args.threadId, args),
    env.DB.prepare(
      `UPDATE threads
       SET snippet = ?, status = 'open', is_read = 0,
           message_count = message_count + 1, last_message_at = ?
       WHERE id = ?`,
    ).bind(args.snippet, args.now, args.threadId),
  ]);
  const messageId = Number(results[0].meta.last_row_id);
  if (!messageId) throw new Error("Inbound message was not stored");
  return { threadId: args.threadId, messageId };
}

async function storeNewConversation(
  env: Env,
  args: StoredMessageInput & { mailboxId: number; catchAllRecipient: string | null; snippet: string },
): Promise<{ threadId: number; messageId: number }> {
  const thread = await env.DB.prepare(
    `INSERT INTO threads
       (mailbox_id, catch_all_recipient, subject, normalized_subject, snippet, message_count, last_message_at)
     VALUES (?, ?, ?, ?, ?, 1, ?) RETURNING id`,
  )
    .bind(
      args.mailboxId,
      args.catchAllRecipient,
      args.subject,
      normalizeSubject(args.subject),
      args.snippet,
      args.now,
    )
    .first<{ id: number }>();
  if (!thread) throw new Error("Conversation was not created");

  try {
    const result = await insertMessage(env, thread.id, args).run();
    const messageId = Number(result.meta.last_row_id);
    if (!messageId) throw new Error("Inbound message was not stored");
    return { threadId: thread.id, messageId };
  } catch (error) {
    await env.DB.prepare("DELETE FROM threads WHERE id = ? AND message_count = 1")
      .bind(thread.id)
      .run();
    throw error;
  }
}

interface StoredMessageInput {
  messageId: string;
  parsed: Email;
  subject: string;
  textBody: string;
  rawKey: string;
  now: string;
}

function insertMessage(env: Env, threadId: number, args: StoredMessageInput) {
  const { parsed } = args;
  const fromName = parsed.from && "name" in parsed.from ? parsed.from.name : null;
  return env.DB.prepare(
    `INSERT INTO messages
       (thread_id, message_id, in_reply_to, references_ids, direction, sent_by,
        from_address, from_name, to_addresses, cc_addresses, reply_to_addresses,
        subject, text_body, html_body, raw_key, is_auto_submitted, created_at)
     VALUES (?, ?, ?, ?, 'inbound', 'external', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    threadId,
    args.messageId,
    parsed.inReplyTo ?? null,
    JSON.stringify(extractMessageIds(parsed)),
    addressOf(parsed.from) || "unknown",
    fromName,
    JSON.stringify(addressesOf(parsed.to)),
    JSON.stringify(addressesOf(parsed.cc)),
    JSON.stringify(addressesOf(parsed.replyTo)),
    args.subject,
    args.textBody,
    parsed.html ?? null,
    args.rawKey,
    isAutoSubmitted(parsed) ? 1 : 0,
    args.now,
  );
}

async function storeAttachments(
  env: Env,
  mailboxId: number,
  messageId: number,
  attachments: Attachment[],
): Promise<void> {
  if (attachments.length === 0) return;
  const statements: D1PreparedStatement[] = [];

  for (const [index, attachment] of attachments.entries()) {
    const bytes = attachmentBytes(attachment.content);
    const r2Key = `attachments/${mailboxId}/${messageId}/${index}-${crypto.randomUUID()}`;
    await env.RAW.put(r2Key, bytes, {
      httpMetadata: { contentType: attachment.mimeType || "application/octet-stream" },
    });
    statements.push(
      env.DB.prepare(
        `INSERT INTO attachments
           (message_id, filename, content_type, size, disposition, content_id, r2_key)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        messageId,
        attachment.filename,
        attachment.mimeType || "application/octet-stream",
        bytes.byteLength,
        attachment.disposition,
        attachment.contentId ?? null,
        r2Key,
      ),
    );
  }

  await env.DB.batch(statements);
}

function extractMessageIds(parsed: Email): string[] {
  const raw = `${parsed.inReplyTo ?? ""} ${parsed.references ?? ""}`;
  return [...new Set(raw.match(/<[^<>\s]+>/g) ?? [])];
}

function htmlToText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

export { normalizeSubject } from "./rules";
