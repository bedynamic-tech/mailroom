import type { Mailbox } from "../../shared/types.ts";

type Db = { DB: D1Database };

export class InboxCreationError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "InboxCreationError";
    this.status = status;
  }
}

export function isLocalPart(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 64 &&
    !value.startsWith(".") &&
    !value.endsWith(".") &&
    !value.includes("..") &&
    /^[a-z0-9._+-]+$/.test(value)
  );
}

export type StoredMailbox = Omit<Mailbox, "unread_count" | "effective_signature_html" | "is_catch_all">;

/** Registers `localPart@domain` as an Inbox on a ready Domain. */
export async function createInbox(
  env: Db,
  input: { localPart: string; domainId: number },
): Promise<StoredMailbox> {
  const localPart = input.localPart.trim().toLowerCase();
  if (!isLocalPart(localPart)) {
    throw new InboxCreationError("Use letters, numbers, dots, dashes, or underscores", 400);
  }
  if (!Number.isInteger(input.domainId) || input.domainId <= 0) {
    throw new InboxCreationError("Choose a domain", 400);
  }

  const domain = await env.DB.prepare("SELECT id, name, status FROM domains WHERE id = ?")
    .bind(input.domainId)
    .first<{ id: number; name: string; status: "pending" | "active" }>();
  if (!domain) throw new InboxCreationError("Domain not found", 404);
  if (domain.status !== "active") {
    throw new InboxCreationError("Finish setting up this domain first", 409);
  }

  const address = `${localPart}@${domain.name}`;
  const existing = await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?")
    .bind(address)
    .first();
  if (existing) throw new InboxCreationError("This inbox already exists", 409);

  try {
    const mailbox = await env.DB.prepare(
      `INSERT INTO mailboxes (address, domain_id)
       VALUES (?, ?) RETURNING *`,
    )
      .bind(address, domain.id)
      .first<StoredMailbox>();
    if (!mailbox) throw new Error("Inbox was not stored");
    return mailbox;
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) {
      throw new InboxCreationError("This inbox already exists", 409);
    }
    throw error;
  }
}
