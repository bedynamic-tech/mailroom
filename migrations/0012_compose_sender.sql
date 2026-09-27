ALTER TABLE outbound_attempts ADD COLUMN sent_by TEXT NOT NULL DEFAULT 'agent'
  CHECK (sent_by IN ('human', 'agent'));
