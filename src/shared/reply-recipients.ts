// The reply box's edited recipients, saved per Conversation (threads.reply_recipients)
// so they follow the user across devices, reloads and sends.

export type ReplyRecipients = {
  // null means To was never edited and follows the latest inbound reply target.
  to: string[] | null;
  // null means Cc was never edited and follows Reply all: everyone else on the latest email.
  cc: string[] | null;
  bcc: string[];
};

export const EMPTY_REPLY_RECIPIENTS: ReplyRecipients = { to: null, cc: null, bcc: [] };

const isAddressList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

/** Reads the stored JSON, falling back to no edits when it is missing or unreadable. */
export function parseReplyRecipients(raw: string | null | undefined): ReplyRecipients {
  if (!raw) return EMPTY_REPLY_RECIPIENTS;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      to: isAddressList(parsed.to) ? parsed.to : null,
      cc: isAddressList(parsed.cc) ? parsed.cc : null,
      bcc: isAddressList(parsed.bcc) ? parsed.bcc : [],
    };
  } catch {
    return EMPTY_REPLY_RECIPIENTS;
  }
}

/** The stored form: null when nothing was edited, so the defaults apply. */
export function serializeReplyRecipients(recipients: ReplyRecipients): string | null {
  if (recipients.to === null && recipients.cc === null && recipients.bcc.length === 0) {
    return null;
  }
  return JSON.stringify(recipients);
}
