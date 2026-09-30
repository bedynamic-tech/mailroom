export interface ConversationDeletionEnv {
  DB: D1Database;
  RAW: R2Bucket;
}

export interface DeletedConversations {
  ids: number[];
  /** R2 objects that belonged only to the deleted Conversations. */
  objectKeys: string[];
}

export class ConversationDeletionError extends Error {
  readonly status: 404 | 409;

  constructor(message: string, status: 404 | 409) {
    super(message);
    this.name = "ConversationDeletionError";
    this.status = status;
  }
}

// D1 allows at most 100 bound parameters per statement.
const MAX_BOUND_PARAMETERS = 100;

/**
 * Permanently deletes archived Conversations with their Messages, Attachments,
 * drafts, Draft Runs, Reply and Send Attempts, Label assignments and
 * Internal Notes. Only archived Conversations can be deleted unless
 * `includeOpen` is set; Contacts are left untouched.
 */
export async function deleteArchivedConversations(
  env: ConversationDeletionEnv,
  input: { ids: number[]; includeOpen?: boolean },
): Promise<DeletedConversations> {
  const ids = [...new Set(input.ids)];
  const includeOpen = input.includeOpen === true;
  // One bound parameter is kept for the latest Message id when open
  // Conversations may be deleted.
  const maxIds = includeOpen ? MAX_BOUND_PARAMETERS - 1 : MAX_BOUND_PARAMETERS;
  if (ids.length === 0 || ids.length > maxIds) {
    throw new Error(`Conversation deletion needs 1-${maxIds} ids`);
  }
  const idList = numberedPlaceholders(ids.length);

  const { results: found } = await env.DB.prepare(
    `SELECT id, status FROM threads WHERE id IN (${idList})`,
  )
    .bind(...ids)
    .all<{ id: number; status: string }>();

  if (found.length === 0) throw new ConversationDeletionError("Conversation not found", 404);
  if (!includeOpen && found.some((thread) => thread.status !== "archived")) {
    throw new ConversationDeletionError(
      "Only archived conversations can be deleted",
      409,
    );
  }
  const targets = found.map((thread) => thread.id);
  const targetList = numberedPlaceholders(targets.length);

  const activeSend = await env.DB.prepare(
    `SELECT 1 AS active FROM reply_attempts
     WHERE thread_id IN (${targetList}) AND status IN ('pending', 'sending')
     UNION ALL
     SELECT 1 AS active FROM outbound_attempts
     WHERE thread_id IN (${targetList}) AND status IN ('pending', 'sending')
     LIMIT 1`,
  )
    .bind(...targets)
    .first<{ active: number }>();
  if (activeSend) {
    throw new ConversationDeletionError(
      "Wait for the current email to finish sending, then try again",
      409,
    );
  }

  const { results: keyRows } = await env.DB.prepare(
    `SELECT raw_key AS key FROM messages
     WHERE thread_id IN (${targetList}) AND raw_key IS NOT NULL
     UNION
     SELECT a.r2_key AS key FROM attachments a
     JOIN messages m ON m.id = a.message_id
     WHERE m.thread_id IN (${targetList})
     UNION
     SELECT json_extract(staged.value, '$.r2_key') AS key
     FROM reply_attempts ra, json_each(ra.attachments) staged
     WHERE ra.thread_id IN (${targetList})
     UNION
     SELECT json_extract(staged.value, '$.r2_key') AS key
     FROM outbound_attempts oa, json_each(oa.attachments) staged
     WHERE oa.thread_id IN (${targetList})`,
  )
    .bind(...targets)
    .all<{ key: string | null }>();
  const candidateKeys = keyRows
    .map((row) => row.key)
    .filter((key): key is string => typeof key === "string" && key.length > 0);

  // An open Conversation is kept if new mail arrives while it is deleted.
  const latest = includeOpen
    ? await env.DB.prepare(
        `SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE thread_id IN (${targetList})`,
      )
        .bind(...targets)
        .first<{ id: number }>()
    : null;
  const latestParam = `?${targets.length + 1}`;
  const unchanged = includeOpen
    ? `NOT EXISTS (
        SELECT 1 FROM messages newer
        WHERE newer.thread_id = threads.id AND newer.id > ${latestParam})`
    : "status = 'archived'";
  const bindings = includeOpen ? [...targets, latest?.id ?? 0] : targets;

  // Re-check every condition inside the batch so a Conversation that was
  // reopened by new mail or started sending in the meantime is kept.
  const deletable = `SELECT id FROM threads
    WHERE id IN (${targetList}) AND ${unchanged}
      AND NOT EXISTS (
        SELECT 1 FROM reply_attempts active
        WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending'))
      AND NOT EXISTS (
        SELECT 1 FROM outbound_attempts active
        WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending'))`;
  await env.DB.batch(
    [
      `DELETE FROM reply_attempts WHERE thread_id IN (${deletable})`,
      `DELETE FROM outbound_attempts WHERE thread_id IN (${deletable})`,
      `DELETE FROM draft_runs WHERE thread_id IN (${deletable})`,
      `DELETE FROM drafts WHERE thread_id IN (${deletable})`,
      `DELETE FROM thread_labels WHERE thread_id IN (${deletable})`,
      `DELETE FROM thread_notes WHERE thread_id IN (${deletable})`,
      `DELETE FROM attachments WHERE message_id IN (
         SELECT id FROM messages WHERE thread_id IN (${deletable}))`,
      `DELETE FROM message_bounces WHERE message_id IN (
         SELECT id FROM messages WHERE thread_id IN (${deletable}))
         OR bounce_message_id IN (SELECT id FROM messages WHERE thread_id IN (${deletable}))`,
      `DELETE FROM messages WHERE thread_id IN (${deletable})`,
      `DELETE FROM threads WHERE id IN (${deletable})`,
    ].map((sql) => env.DB.prepare(sql).bind(...bindings)),
  );

  const { results: kept } = await env.DB.prepare(
    `SELECT id FROM threads WHERE id IN (${targetList})`,
  )
    .bind(...targets)
    .all<{ id: number }>();
  const keptIds = new Set(kept.map((row) => row.id));
  const deletedIds = targets.filter((id) => !keptIds.has(id));
  if (deletedIds.length === 0) {
    throw new ConversationDeletionError(
      "Conversation changed while it was being deleted",
      409,
    );
  }

  return {
    ids: deletedIds,
    objectKeys: await unreferencedKeys(env.DB, candidateKeys),
  };
}

/**
 * Deletes every archived Conversation across all Inboxes, 100 at a time.
 * Conversations with an email still sending are skipped and stay archived.
 */
export async function emptyArchive(
  env: ConversationDeletionEnv,
): Promise<DeletedConversations & { skipped: number }> {
  const deleted: DeletedConversations = { ids: [], objectKeys: [] };
  let skipped = 0;
  let afterId = 0;

  for (;;) {
    const { results } = await env.DB.prepare(
      `SELECT id, EXISTS (
         SELECT 1 FROM reply_attempts active
         WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending')
         UNION ALL
         SELECT 1 FROM outbound_attempts active
         WHERE active.thread_id = threads.id AND active.status IN ('pending', 'sending')
       ) AS sending
       FROM threads WHERE status = 'archived' AND id > ?
       ORDER BY id LIMIT ?`,
    )
      .bind(afterId, MAX_BOUND_PARAMETERS)
      .all<{ id: number; sending: number }>();
    if (results.length === 0) break;
    afterId = results.at(-1)!.id;

    const ids = results.filter((row) => !row.sending).map((row) => row.id);
    skipped += results.length - ids.length;
    if (ids.length === 0) continue;

    try {
      const batch = await deleteArchivedConversations(env, { ids });
      deleted.ids.push(...batch.ids);
      deleted.objectKeys.push(...batch.objectKeys);
      skipped += ids.length - batch.ids.length;
    } catch (error) {
      // A batch that changed underneath us (new mail reopened a Conversation
      // or a send started) is left in place rather than failing the rest.
      if (!(error instanceof ConversationDeletionError)) throw error;
      skipped += ids.length;
    }
  }

  return { ...deleted, skipped };
}

export async function purgeConversationObjects(
  bucket: R2Bucket,
  keys: string[],
): Promise<void> {
  for (let index = 0; index < keys.length; index += 1_000) {
    await bucket.delete(keys.slice(index, index + 1_000));
  }
}

/** Drops keys that are still referenced by a Message or Attempt that was kept. */
export async function unreferencedKeys(db: D1Database, keys: string[]): Promise<string[]> {
  const unique = [...new Set(keys)];
  const referenced = new Set<string>();

  for (let index = 0; index < unique.length; index += MAX_BOUND_PARAMETERS) {
    const chunk = unique.slice(index, index + MAX_BOUND_PARAMETERS);
    const keyList = numberedPlaceholders(chunk.length);
    const { results } = await db.prepare(
      `SELECT raw_key AS key FROM messages WHERE raw_key IN (${keyList})
       UNION
       SELECT r2_key AS key FROM attachments WHERE r2_key IN (${keyList})
       UNION
       SELECT json_extract(staged.value, '$.r2_key') AS key
       FROM reply_attempts ra, json_each(ra.attachments) staged
       WHERE json_extract(staged.value, '$.r2_key') IN (${keyList})
       UNION
       SELECT json_extract(staged.value, '$.r2_key') AS key
       FROM outbound_attempts oa, json_each(oa.attachments) staged
       WHERE json_extract(staged.value, '$.r2_key') IN (${keyList})`,
    )
      .bind(...chunk)
      .all<{ key: string }>();
    for (const row of results) referenced.add(row.key);
  }

  return unique.filter((key) => !referenced.has(key));
}

function numberedPlaceholders(count: number): string {
  return Array.from({ length: count }, (_, index) => `?${index + 1}`).join(", ");
}
