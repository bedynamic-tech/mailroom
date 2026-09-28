// Remembers the reply box's edited recipients per conversation in this browser,
// so they survive leaving the conversation, reloading, and sending.

export type ReplyRecipients = {
  // null means To was never edited and follows the latest inbound reply target.
  to: string[] | null;
  cc: string[];
  bcc: string[];
};

export const EMPTY_REPLY_RECIPIENTS: ReplyRecipients = { to: null, cc: [], bcc: [] };

const keyFor = (threadId: number) => `mailroom.replyRecipients.${threadId}`;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function defaultStorage(): StorageLike | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

const isAddressList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function readReplyRecipients(
  threadId: number,
  storage: StorageLike | null = defaultStorage(),
): ReplyRecipients {
  try {
    const raw = storage?.getItem(keyFor(threadId));
    if (!raw) return EMPTY_REPLY_RECIPIENTS;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      to: isAddressList(parsed.to) ? parsed.to : null,
      cc: isAddressList(parsed.cc) ? parsed.cc : [],
      bcc: isAddressList(parsed.bcc) ? parsed.bcc : [],
    };
  } catch {
    return EMPTY_REPLY_RECIPIENTS;
  }
}

export function writeReplyRecipients(
  threadId: number,
  recipients: ReplyRecipients,
  storage: StorageLike | null = defaultStorage(),
) {
  try {
    if (recipients.to === null && recipients.cc.length === 0 && recipients.bcc.length === 0) {
      storage?.removeItem(keyFor(threadId));
    } else {
      storage?.setItem(keyFor(threadId), JSON.stringify(recipients));
    }
  } catch {
    // Storage can be unavailable (private mode, blocked site data).
  }
}
