export async function enqueueDraftRun(
  env: Env,
  threadId: number,
  inboundMessageId: number,
): Promise<number> {
  const existing = await env.DB.prepare(
    "SELECT id, status FROM draft_runs WHERE inbound_message_id = ?",
  )
    .bind(inboundMessageId)
    .first<{
      id: number;
      status: "queued" | "generating" | "ready" | "failed" | "superseded";
    }>();

  if (
    existing?.status === "ready" ||
    existing?.status === "generating" ||
    existing?.status === "superseded"
  ) return existing.id;

  const run = existing
    ? await env.DB.prepare(
        `UPDATE draft_runs
         SET status = 'queued', error = NULL, started_at = NULL, finished_at = NULL
         WHERE id = ? RETURNING id`,
      )
        .bind(existing.id)
        .first<{ id: number }>()
    : await env.DB.prepare(
        `INSERT INTO draft_runs (thread_id, inbound_message_id)
         VALUES (?, ?) RETURNING id`,
      )
        .bind(threadId, inboundMessageId)
        .first<{ id: number }>();

  if (!run) throw new Error("Could not create draft run");
  await env.DRAFT_QUEUE.send({ runId: run.id });
  return run.id;
}
