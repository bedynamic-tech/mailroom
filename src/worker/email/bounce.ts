import type { Attachment, Email } from "postal-mime";
import { addressOf, attachmentBytes } from "./rules.ts";

/**
 * Bounce detection for outbound mail. A receiving server that rejects one of
 * our emails sends a bounce notice back to the Inbox that sent it. Most are
 * RFC 3464 delivery status notifications with one block per recipient, so a
 * Cc that bounced is told apart from a To that was delivered. Older servers
 * send plain-text notices from MAILER-DAEMON, read here on a best-effort basis.
 */

export interface BouncedRecipient {
  address: string;
  /** Enhanced status code such as 5.1.1, when the notice gave one. */
  status: string | null;
  diagnostic: string;
}

export interface BounceReport {
  kind: "dsn" | "text";
  /** Recipients the notice reported as permanently failed. */
  failed: BouncedRecipient[];
  /** Addresses a plain-text notice mentions; matched against the original's recipients. */
  mentioned: string[];
  /** Human-readable summary, used when a recipient has no diagnostic of its own. */
  summary: string;
  /** Message-IDs the notice points at: the returned original, In-Reply-To and References. */
  originalMessageIds: string[];
}

const DSN_TYPES = new Set(["message/delivery-status", "message/global-delivery-status"]);
const RETURNED_TYPES = new Set(["message/rfc822", "text/rfc822-headers", "message/global", "message/global-headers"]);
const DAEMON_SENDER = /^(mailer-daemon|mail-daemon|postmaster|mail-delivery|maildelivery|mailer)(\+.*)?$/i;
const TEXT_BOUNCE_SUBJECT =
  /undeliver|delivery (status notification|has failed|failure|failed)|failure notice|returned mail|mail delivery (failed|failure|system)|could not be delivered|not delivered|delivery incomplete/i;
const DIAGNOSTIC_LIMIT = 500;

/** Reads a bounce notice, or returns null when the email is not one. */
export function parseBounce(parsed: Email): BounceReport | null {
  const dsnParts = parsed.attachments.filter((item) => DSN_TYPES.has(item.mimeType.toLowerCase()));
  const summary = humanSummary(parsed);
  if (dsnParts.length > 0) {
    const failed: BouncedRecipient[] = [];
    for (const part of dsnParts) {
      for (const recipient of parseDeliveryStatus(decode(part))) {
        if (!failed.some((entry) => entry.address === recipient.address)) failed.push(recipient);
      }
    }
    return {
      kind: "dsn",
      failed,
      mentioned: [],
      summary,
      originalMessageIds: originalMessageIds(parsed),
    };
  }

  const sender = addressOf(parsed.from);
  const localPart = sender.split("@")[0] ?? "";
  if (!DAEMON_SENDER.test(localPart) || !TEXT_BOUNCE_SUBJECT.test(parsed.subject ?? "")) return null;
  const notice = noticeText(parsed.text ?? "");
  return {
    kind: "text",
    failed: [],
    mentioned: [...new Set(notice.match(/[^\s<>"'(),;:[\]]+@[^\s<>"'(),;:[\]]+\.[a-z]{2,}/gi) ?? [])]
      .map((address) => address.toLowerCase().replace(/\.$/, ""))
      .filter((address) => address !== sender),
    summary,
    originalMessageIds: originalMessageIds(parsed),
  };
}

/** Parses an RFC 3464 message/delivery-status body into its failed recipients. */
export function parseDeliveryStatus(body: string): BouncedRecipient[] {
  const blocks = body
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map(parseFields)
    .filter((fields) => fields.size > 0);
  const failed: BouncedRecipient[] = [];
  // The first block holds per-message fields; the rest describe one recipient each.
  for (const fields of blocks) {
    const recipient = addressField(fields.get("original-recipient")) ?? addressField(fields.get("final-recipient"));
    if (!recipient) continue;
    const action = (fields.get("action") ?? "").trim().toLowerCase();
    const status = (fields.get("status") ?? "").trim().match(/^\d\.\d{1,3}\.\d{1,3}/)?.[0] ?? null;
    const isFailure = action ? action === "failed" : status?.startsWith("5") === true;
    if (!isFailure) continue;
    const alternate = addressField(fields.get("final-recipient"));
    failed.push({
      address: recipient,
      status,
      diagnostic: cleanDiagnostic(fields.get("diagnostic-code") ?? ""),
    });
    // A notice about a forwarded address names the final mailbox too.
    if (alternate && alternate !== recipient) {
      failed.push({ address: alternate, status, diagnostic: cleanDiagnostic(fields.get("diagnostic-code") ?? "") });
    }
  }
  return failed;
}

function parseFields(block: string): Map<string, string> {
  const fields = new Map<string, string>();
  let current: string | null = null;
  for (const line of block.split("\n")) {
    if (/^[ \t]/.test(line) && current) {
      fields.set(current, `${fields.get(current)} ${line.trim()}`);
      continue;
    }
    const match = line.match(/^([A-Za-z0-9-]+)\s*:\s*(.*)$/);
    if (!match) {
      current = null;
      continue;
    }
    current = match[1].toLowerCase();
    if (!fields.has(current)) fields.set(current, match[2].trim());
  }
  return fields;
}

/** "rfc822; Jane@Example.com" becomes "jane@example.com". */
function addressField(value: string | undefined): string | null {
  if (!value) return null;
  const raw = value.includes(";") ? value.slice(value.indexOf(";") + 1) : value;
  const address = raw.trim().replace(/^<|>$/g, "").trim().toLowerCase();
  return address.includes("@") ? address : null;
}

function cleanDiagnostic(value: string): string {
  const text = value
    .replace(/^\s*(smtp|x-[a-z0-9-]+)\s*;\s*/i, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…` : text;
}

function decode(attachment: Attachment): string {
  return new TextDecoder().decode(attachmentBytes(attachment.content));
}

function originalMessageIds(parsed: Email): string[] {
  const ids: string[] = [];
  for (const part of parsed.attachments) {
    if (!RETURNED_TYPES.has(part.mimeType.toLowerCase())) continue;
    const headers = parseFields(decode(part).replace(/\r\n/g, "\n").split(/\n[ \t]*\n/)[0] ?? "");
    ids.push(...messageIdsIn(headers.get("message-id")));
  }
  for (const header of parsed.headers ?? []) {
    const key = header.key.toLowerCase();
    if (key === "original-message-id" || key === "x-original-message-id") ids.push(...messageIdsIn(header.value));
  }
  ids.push(...messageIdsIn(parsed.inReplyTo), ...messageIdsIn(parsed.references));
  // Plain-text notices often quote the original's headers in the body.
  for (const match of (parsed.text ?? "").matchAll(/^\s*Message-ID:\s*(<[^<>\s]+>)/gim)) ids.push(match[1]);
  return [...new Set(ids)];
}

function messageIdsIn(value: string | undefined): string[] {
  return value?.match(/<[^<>\s]+>/g) ?? [];
}

/** The notice's own words, before any quoted copy of the original email. */
function noticeText(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const end = lines.findIndex(
    (line) =>
      /^\s*(-{2,}.*(original message|copy of|returned message|below this line|message headers).*|received:|return-path:|from:|to:|cc:|subject:|message-id:|date:)/i.test(line),
  );
  return (end === -1 ? lines : lines.slice(0, end)).join("\n");
}

function humanSummary(parsed: Email): string {
  const text = noticeText(parsed.text ?? "").replace(/\s+/g, " ").trim();
  return text.length > DIAGNOSTIC_LIMIT ? `${text.slice(0, DIAGNOSTIC_LIMIT - 1)}…` : text;
}

interface OutboundCandidate {
  id: number;
  to_addresses: string;
  cc_addresses: string;
  bcc_addresses: string;
}

export interface MatchedBounce {
  /** The outbound Message the notice is about. */
  messageId: number;
  /** Failed recipients of that Message; empty for a delay or success notice. */
  recipients: BouncedRecipient[];
}

/**
 * Finds the outbound Message a bounce notice is about, sent from the Inbox
 * the notice came back to, and which of its recipients failed. Returns null
 * when no sent Message matches, so the notice is stored as ordinary mail.
 */
export async function matchBounce(
  env: Env,
  mailboxId: number,
  report: BounceReport,
): Promise<MatchedBounce | null> {
  const candidates = report.kind === "dsn"
    ? report.failed.map((recipient) => recipient.address)
    : report.mentioned;
  let original: OutboundCandidate | null = null;
  if (report.originalMessageIds.length > 0) {
    const placeholders = report.originalMessageIds.map(() => "?").join(", ");
    original = await env.DB.prepare(
      `SELECT m.id, m.to_addresses, m.cc_addresses, m.bcc_addresses
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE t.mailbox_id = ? AND m.direction = 'outbound' AND m.message_id IN (${placeholders})
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    )
      .bind(mailboxId, ...report.originalMessageIds)
      .first<OutboundCandidate>();
  }
  // Without a usable Message-ID, the most recent email from this Inbox to a
  // failed address in the last two weeks is the one that bounced.
  if (!original && candidates.length > 0) {
    const placeholders = candidates.map(() => "?").join(", ");
    original = await env.DB.prepare(
      `SELECT m.id, m.to_addresses, m.cc_addresses, m.bcc_addresses
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE t.mailbox_id = ? AND m.direction = 'outbound'
         AND m.created_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-14 days')
         AND EXISTS (
           SELECT 1 FROM json_each(m.to_addresses) r WHERE lower(r.value) IN (${placeholders})
           UNION ALL
           SELECT 1 FROM json_each(m.cc_addresses) r WHERE lower(r.value) IN (${placeholders})
           UNION ALL
           SELECT 1 FROM json_each(m.bcc_addresses) r WHERE lower(r.value) IN (${placeholders})
         )
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1`,
    )
      .bind(mailboxId, ...candidates, ...candidates, ...candidates)
      .first<OutboundCandidate>();
  }
  if (!original) return null;

  const sentTo = new Set(
    [original.to_addresses, original.cc_addresses, original.bcc_addresses]
      .flatMap(parseAddressList)
      .map((address) => address.toLowerCase()),
  );
  const recipients = report.kind === "dsn"
    ? report.failed.filter((recipient) => sentTo.has(recipient.address))
    : report.mentioned
        .filter((address) => sentTo.has(address))
        .map((address) => ({ address, status: statusIn(report.summary), diagnostic: "" }));
  // A DSN may name only the final mailbox a recipient forwards to; when it
  // points at this email by Message-ID, keep that address rather than lose it.
  if (report.kind === "dsn" && recipients.length === 0 && report.failed.length > 0 && report.originalMessageIds.length > 0) {
    recipients.push(...report.failed);
  }
  return {
    messageId: original.id,
    recipients: recipients.map((recipient) => ({
      ...recipient,
      diagnostic: recipient.diagnostic || report.summary,
    })),
  };
}

function statusIn(text: string): string | null {
  return text.match(/\b(5\.\d{1,3}\.\d{1,3})\b/)?.[1] ?? null;
}

function parseAddressList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

/** Records each failed recipient once; a repeated notice for the same one is ignored. */
export async function recordBounces(
  env: Env,
  match: MatchedBounce,
  bounceMessageId: number,
): Promise<void> {
  if (match.recipients.length === 0) return;
  await env.DB.batch(
    match.recipients.map((recipient) =>
      env.DB.prepare(
        `INSERT INTO message_bounces (message_id, recipient, status, diagnostic, bounce_message_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (message_id, recipient) DO NOTHING`,
      ).bind(match.messageId, recipient.address, recipient.status, recipient.diagnostic, bounceMessageId),
    ),
  );
}
