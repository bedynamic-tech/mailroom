import {
  MAX_ATTACHMENT_TOTAL_BYTES,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_MESSAGE_CHARS,
  MAX_SUBJECT_CHARS,
} from "../../shared/email-limits.ts";
import { forwardSubject } from "../../shared/forward.ts";
import { senderFrom } from "../../shared/sender-name.ts";
import type { MailRuleAddress } from "../../shared/mail-rules.ts";
import type { RuleForward } from "./mail-rules.ts";
import { claimDailySendBudget } from "./send-budget.ts";
import { sendEmail, type OutgoingAttachment, type SendEmailEnv } from "./send.ts";

/** Forwards all Mail Rules may send per UTC day, across the workspace. */
export const DAILY_RULE_FORWARD_LIMIT = 200;
const BUDGET_ACTOR = "mail-rule-forward";

export interface ForwardedOriginal {
  from: MailRuleAddress;
  /** Where the forward's recipients should reply: the original Reply-To or sender. */
  replyTo: string | null;
  to: MailRuleAddress[];
  cc: MailRuleAddress[];
  date: string | null;
  subject: string;
  text: string;
  attachments: Array<{
    filename: string | null;
    mimeType: string;
    content: ArrayBuffer | Uint8Array | string;
  }>;
}

export type RuleForwardResult =
  | { status: "sent"; messageId: string }
  | { status: "duplicate" }
  | { status: "failed"; error: string };

/**
 * Sends one Mail Rule's forward of a stored inbound Message from the Inbox
 * that received it, at most once per rule and Message. Failures are recorded
 * on the forward, where the Rules settings show them, rather than thrown.
 */
export async function sendRuleForward(
  env: SendEmailEnv & { DB: D1Database },
  args: { forward: RuleForward; mailboxId: number; messageId: number; original: ForwardedOriginal },
): Promise<RuleForwardResult> {
  const claim = await env.DB.prepare(
    `INSERT INTO mail_rule_forwards (rule_id, message_id) VALUES (?, ?)
     ON CONFLICT (rule_id, message_id) DO NOTHING RETURNING id`,
  )
    .bind(args.forward.ruleId, args.messageId)
    .first<{ id: number }>();
  if (!claim) return { status: "duplicate" };

  const fail = async (error: string): Promise<RuleForwardResult> => {
    await finish(env, claim.id, { status: "failed", error });
    console.error("Rule forward failed", { ruleId: args.forward.ruleId, messageId: args.messageId, error });
    return { status: "failed", error };
  };

  try {
    const inbox = await env.DB.prepare(
      `SELECT m.address, m.display_name, d.status AS domain_status
       FROM mailboxes m LEFT JOIN domains d ON d.id = m.domain_id WHERE m.id = ?`,
    )
      .bind(args.mailboxId)
      .first<{ address: string; display_name: string | null; domain_status: string | null }>();
    if (!inbox) return await fail("The inbox no longer exists");
    if (inbox.domain_status !== "active") return await fail("The inbox's domain is not ready for sending");

    // Inboxes added since the rule was saved are dropped, so a forward never loops.
    const { results: inboxes } = await env.DB.prepare("SELECT lower(address) AS address FROM mailboxes")
      .all<{ address: string }>();
    const own = new Set(inboxes.map((row) => row.address));
    const external = (list: string[]) => list.filter((address) => !own.has(address.toLowerCase()));
    const to = external(args.forward.to);
    if (to.length === 0) return await fail("Every To address is one of this workspace's inboxes");

    if (!(await claimDailySendBudget(env, BUDGET_ACTOR, DAILY_RULE_FORWARD_LIMIT))) {
      return await fail(`Daily limit of ${DAILY_RULE_FORWARD_LIMIT} forwards reached`);
    }

    const content = buildForward(args.original);
    const { messageId } = await sendEmail(env, {
      from: senderFrom(inbox.address, inbox.display_name),
      to,
      cc: external(args.forward.cc),
      bcc: external(args.forward.bcc),
      subject: content.subject,
      text: content.text,
      attachments: content.attachments,
      replyTo: args.original.replyTo ?? undefined,
      forwardedByRule: args.forward.ruleId,
    });
    await finish(env, claim.id, { status: "sent", messageId });
    return { status: "sent", messageId };
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function finish(
  env: { DB: D1Database },
  id: number,
  result: { status: "sent"; messageId: string } | { status: "failed"; error: string },
): Promise<void> {
  await env.DB.prepare(
    `UPDATE mail_rule_forwards
     SET status = ?, provider_message_id = ?, error = ?,
         updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE id = ?`,
  )
    .bind(
      result.status,
      result.status === "sent" ? result.messageId : null,
      result.status === "failed" ? result.error.slice(0, 2000) : null,
      id,
    )
    .run();
}

/**
 * The forward's subject, text and attachments: the original's headers and
 * text below a "Forwarded message" line, with as many of its attachments as
 * the send limits allow and a note naming any left out.
 */
export function buildForward(original: ForwardedOriginal): {
  subject: string;
  text: string;
  attachments: OutgoingAttachment[];
} {
  const subject = forwardSubject(original.subject);

  const attachments: OutgoingAttachment[] = [];
  const omitted: string[] = [];
  let bytes = 0;
  for (const attachment of original.attachments) {
    const content = typeof attachment.content === "string"
      ? new TextEncoder().encode(attachment.content)
      : attachment.content;
    const filename = attachment.filename || "attachment";
    if (
      attachments.length >= MAX_ATTACHMENTS_PER_MESSAGE ||
      bytes + content.byteLength > MAX_ATTACHMENT_TOTAL_BYTES
    ) {
      omitted.push(filename);
      continue;
    }
    bytes += content.byteLength;
    attachments.push({
      content,
      filename,
      type: attachment.mimeType || "application/octet-stream",
      disposition: "attachment",
    });
  }

  const list = (entries: MailRuleAddress[]) => entries.map(formatAddress).join(", ");
  const header = [
    "---------- Forwarded message ---------",
    `From: ${formatAddress(original.from)}`,
    original.date ? `Date: ${original.date}` : null,
    `Subject: ${original.subject || "(no subject)"}`,
    original.to.length ? `To: ${list(original.to)}` : null,
    original.cc.length ? `Cc: ${list(original.cc)}` : null,
  ].filter((line): line is string => line !== null);
  const note = omitted.length
    ? `\n\n[${omitted.length} attachment${omitted.length === 1 ? " was" : "s were"} too large to forward: ${omitted.join(", ")}]`
    : "";

  return {
    subject: subject.slice(0, MAX_SUBJECT_CHARS),
    text: `${header.join("\n")}\n\n${original.text.trim()}${note}`.slice(0, MAX_MESSAGE_CHARS),
    attachments,
  };
}

function formatAddress(entry: MailRuleAddress): string {
  if (!entry.address) return entry.name ?? "unknown";
  return entry.name ? `${entry.name} <${entry.address}>` : entry.address;
}
