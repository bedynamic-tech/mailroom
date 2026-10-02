import { isEmailAddress } from "../../shared/recipients.ts";
import type {
  BlockedRecipient,
  BlockRecipientResult,
  CatchAllAddress,
} from "../../shared/types.ts";
import { createInbox, InboxCreationError, type StoredMailbox } from "./create.ts";

type Db = { DB: D1Database };

export interface InboundMailbox {
  id: number;
  address: string;
  agent_mode: string;
}

export type InboundTarget =
  | { kind: "inbox"; mailbox: InboundMailbox; catchAllRecipient: null }
  | { kind: "caught"; mailbox: InboundMailbox; catchAllRecipient: string; archive: boolean }
  | { kind: "blocked"; ruleId: number }
  | { kind: "unknown" };

export class CatchAllError extends Error {
  readonly status: 400 | 404 | 409;

  constructor(message: string, status: 400 | 404 | 409) {
    super(message);
    this.name = "CatchAllError";
    this.status = status;
  }
}

/**
 * Decides where mail for `recipient` goes. An Inbox with that exact address
 * always wins; otherwise the Domain's catch-all Inbox takes it, unless the
 * address is a Blocked Address, whose rejection is counted on the rule.
 * `archive` says whether the Domain files caught mail into the Archive.
 */
export async function resolveInboundTarget(
  env: Db,
  recipient: string,
  now = new Date().toISOString(),
): Promise<InboundTarget> {
  const address = recipient.trim().toLowerCase();
  const inbox = await env.DB.prepare("SELECT id, address, agent_mode FROM mailboxes WHERE address = ?")
    .bind(address)
    .first<InboundMailbox>();
  if (inbox) return { kind: "inbox", mailbox: inbox, catchAllRecipient: null };

  const at = address.lastIndexOf("@");
  if (at <= 0) return { kind: "unknown" };
  const catchAll = await env.DB.prepare(
    `SELECT m.id, m.address, m.agent_mode, d.catch_all_archive
     FROM domains d JOIN mailboxes m ON m.id = d.catch_all_mailbox_id
     WHERE d.name = ?`,
  )
    .bind(address.slice(at + 1))
    .first<InboundMailbox & { catch_all_archive: number }>();
  if (!catchAll) return { kind: "unknown" };

  const blocked = await env.DB.prepare(
    `UPDATE blocked_recipients
     SET blocked_count = blocked_count + 1, last_blocked_at = ?
     WHERE address = ? RETURNING id`,
  )
    .bind(now, address)
    .first<{ id: number }>();
  if (blocked) return { kind: "blocked", ruleId: blocked.id };

  const { catch_all_archive, ...mailbox } = catchAll;
  return { kind: "caught", mailbox, catchAllRecipient: address, archive: Boolean(catch_all_archive) };
}

/**
 * Sets which Inbox receives a Domain's mail for addresses that have no Inbox
 * of their own, or turns the Domain's catch-all off with null. The Inbox must
 * be on that Domain. With `archive`, caught mail lands in the Archive, read.
 */
export async function setDomainCatchAll(
  env: Db,
  domainId: number,
  mailboxId: number | null,
  archive = false,
): Promise<void> {
  const domain = await env.DB.prepare("SELECT id FROM domains WHERE id = ?").bind(domainId).first();
  if (!domain) throw new CatchAllError("Domain not found", 404);
  if (mailboxId !== null) {
    const inbox = await env.DB.prepare("SELECT id FROM mailboxes WHERE id = ? AND domain_id = ?")
      .bind(mailboxId, domainId)
      .first();
    if (!inbox) throw new CatchAllError("Choose an inbox on this domain", 400);
  }
  await env.DB.prepare("UPDATE domains SET catch_all_mailbox_id = ?, catch_all_archive = ? WHERE id = ?")
    .bind(mailboxId, mailboxId !== null && archive ? 1 : 0, domainId)
    .run();
}

/** The addresses an Inbox has caught mail for, most recently active first. */
export async function listCatchAllAddresses(env: Db, mailboxId: number): Promise<CatchAllAddress[]> {
  const { results } = await env.DB.prepare(
    `SELECT t.catch_all_recipient AS address,
       COUNT(*) AS conversation_count,
       SUM(CASE WHEN t.is_read = 0 AND t.status <> 'archived' THEN 1 ELSE 0 END) AS unread_count,
       MAX(t.last_message_at) AS last_message_at,
       (SELECT b.id FROM blocked_recipients b WHERE b.address = t.catch_all_recipient) AS blocked_id
     FROM threads t
     WHERE t.mailbox_id = ? AND t.catch_all_recipient IS NOT NULL
     GROUP BY t.catch_all_recipient
     ORDER BY last_message_at DESC`,
  )
    .bind(mailboxId)
    .all<CatchAllAddress>();
  return results.map((row) => ({
    ...row,
    conversation_count: Number(row.conversation_count),
    unread_count: Number(row.unread_count ?? 0),
  }));
}

export async function listBlockedRecipients(env: Db): Promise<BlockedRecipient[]> {
  const { results } = await env.DB.prepare(
    "SELECT * FROM blocked_recipients ORDER BY created_at DESC, id DESC",
  ).all<BlockedRecipient>();
  return results;
}

/**
 * Blocks an address on one of the workspace's Domains so the catch-all
 * rejects mail sent to it, and archives the open Conversations already caught
 * for it. An address that has its own Inbox cannot be blocked this way.
 */
export async function blockRecipient(env: Db, value: unknown): Promise<BlockRecipientResult> {
  const address = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!isEmailAddress(address)) throw new CatchAllError("Enter an email address", 400);

  const domain = await env.DB.prepare("SELECT id FROM domains WHERE name = ?")
    .bind(address.slice(address.lastIndexOf("@") + 1))
    .first();
  if (!domain) throw new CatchAllError(`${address} isn't on one of your domains`, 400);
  const inbox = await env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?")
    .bind(address)
    .first();
  if (inbox) {
    throw new CatchAllError(`${address} is an inbox. Delete the inbox to stop its mail.`, 409);
  }

  const [, archived] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO blocked_recipients (address) VALUES (?) ON CONFLICT (address) DO NOTHING",
    ).bind(address),
    env.DB.prepare(
      `UPDATE threads SET status = 'archived', is_read = 1
       WHERE catch_all_recipient = ? AND status <> 'archived'`,
    ).bind(address),
  ]);
  const blocked = await env.DB.prepare("SELECT * FROM blocked_recipients WHERE address = ?")
    .bind(address)
    .first<BlockedRecipient>();
  if (!blocked) throw new Error("Blocked address was not stored");
  return { blocked, archived: Number(archived.meta.changes ?? 0) };
}

export async function unblockRecipient(env: Db, id: number): Promise<boolean> {
  const result = await env.DB.prepare("DELETE FROM blocked_recipients WHERE id = ?").bind(id).run();
  return Boolean(result.meta.changes);
}

/**
 * Turns an address the catch-all has been receiving into its own Inbox, so
 * new mail to it arrives there. With `moveConversations`, the Conversations
 * already caught for it move over too; their Labels belonged to the catch-all
 * Inbox, so they are dropped. A Blocked Address rule for it is removed.
 */
export async function createInboxFromCatchAll(
  env: Db,
  input: { address: unknown; moveConversations: boolean },
): Promise<{ mailbox: StoredMailbox; moved: number }> {
  const address = typeof input.address === "string" ? input.address.trim().toLowerCase() : "";
  if (!isEmailAddress(address)) throw new CatchAllError("Enter an email address", 400);
  const at = address.lastIndexOf("@");
  const domain = await env.DB.prepare("SELECT id FROM domains WHERE name = ?")
    .bind(address.slice(at + 1))
    .first<{ id: number }>();
  if (!domain) throw new CatchAllError(`${address} isn't on one of your domains`, 400);

  let mailbox: StoredMailbox;
  try {
    mailbox = await createInbox(env, { localPart: address.slice(0, at), domainId: domain.id });
  } catch (error) {
    if (error instanceof InboxCreationError) throw new CatchAllError(error.message, error.status);
    throw error;
  }

  const statements = [
    env.DB.prepare("DELETE FROM blocked_recipients WHERE address = ?").bind(address),
  ];
  if (input.moveConversations) {
    statements.push(
      env.DB.prepare(
        `DELETE FROM thread_labels
         WHERE thread_id IN (SELECT id FROM threads WHERE catch_all_recipient = ?)`,
      ).bind(address),
      env.DB.prepare(
        `UPDATE threads SET mailbox_id = ?, catch_all_recipient = NULL
         WHERE catch_all_recipient = ?`,
      ).bind(mailbox.id, address),
    );
  }
  const results = await env.DB.batch(statements);
  const moved = input.moveConversations ? Number(results.at(-1)?.meta.changes ?? 0) : 0;
  return { mailbox, moved };
}
