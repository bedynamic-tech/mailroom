const PREFIXES = {
  inbox: "inbox_",
  conversation: "conversation_",
  message: "message_",
  draft: "draft_",
} as const;

export type EntityKind = keyof typeof PREFIXES;

export function entityId(kind: EntityKind, id: number): string {
  return `${PREFIXES[kind]}${id}`;
}

export function parseEntityId(kind: EntityKind, value: string): number | null {
  const prefix = PREFIXES[kind];
  if (!value.startsWith(prefix)) return null;
  const raw = value.slice(prefix.length);
  if (!/^\d+$/.test(raw)) return null;
  const id = Number(raw);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export interface ConversationCursor {
  lastMessageAt: string;
  id: number;
}

export function encodeCursor(cursor: ConversationCursor): string {
  return btoa(JSON.stringify(cursor))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export function decodeCursor(value: string | undefined): ConversationCursor | null {
  if (!value) return null;
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const parsed = JSON.parse(atob(padded)) as Partial<ConversationCursor>;
    if (
      typeof parsed.lastMessageAt !== "string" ||
      !Number.isSafeInteger(parsed.id) ||
      Number(parsed.id) <= 0
    ) {
      return null;
    }
    return { lastMessageAt: parsed.lastMessageAt, id: Number(parsed.id) };
  } catch {
    return null;
  }
}
