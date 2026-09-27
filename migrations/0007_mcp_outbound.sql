ALTER TABLE reply_attempts ADD COLUMN sent_by TEXT NOT NULL DEFAULT 'human'
  CHECK (sent_by IN ('human', 'agent'));
ALTER TABLE reply_attempts ADD COLUMN actor_id TEXT;
ALTER TABLE reply_attempts ADD COLUMN oauth_client_id TEXT;

CREATE TABLE outbound_attempts (
  id TEXT PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE RESTRICT,
  thread_id INTEGER REFERENCES threads(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  to_addresses TEXT NOT NULL,
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  message_id TEXT UNIQUE,
  actor_id TEXT,
  oauth_client_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_outbound_attempts_mailbox
  ON outbound_attempts(mailbox_id, created_at DESC);
CREATE INDEX idx_outbound_attempts_thread
  ON outbound_attempts(thread_id, created_at DESC);
