-- Historical replies created from an Agent Draft were agent-authored even
-- though a human approved the final send.
UPDATE reply_attempts SET sent_by = 'agent' WHERE draft_id IS NOT NULL;

CREATE TABLE mcp_send_budget (
  actor_id TEXT NOT NULL,
  budget_date TEXT NOT NULL,
  send_count INTEGER NOT NULL DEFAULT 0 CHECK (send_count >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (actor_id, budget_date)
);
