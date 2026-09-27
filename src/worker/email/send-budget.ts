export interface SendBudgetEnv {
  DB: D1Database;
}

export async function claimDailySendBudget(
  env: SendBudgetEnv,
  actorId: string,
  limit: number,
): Promise<boolean> {
  if (!Number.isInteger(limit) || limit <= 0) return false;
  const day = new Date().toISOString().slice(0, 10);
  const claimed = await env.DB.prepare(
    `INSERT INTO mcp_send_budget (actor_id, budget_date, send_count)
     VALUES (?, ?, 1)
     ON CONFLICT(actor_id, budget_date) DO UPDATE SET
       send_count = send_count + 1,
       updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
     WHERE send_count < ?
     RETURNING send_count`,
  )
    .bind(actorId, day, limit)
    .first<{ send_count: number }>();
  return Boolean(claimed);
}
