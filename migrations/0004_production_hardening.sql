ALTER TABLE messages ADD COLUMN reply_to_addresses TEXT NOT NULL DEFAULT '[]';

CREATE TABLE attachments (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  filename TEXT,
  content_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  disposition TEXT CHECK (disposition IN ('attachment', 'inline')),
  content_id TEXT,
  r2_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_attachments_message ON attachments(message_id, id);

CREATE TABLE draft_runs (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  inbound_message_id INTEGER NOT NULL UNIQUE REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'generating', 'ready', 'failed', 'superseded')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  finished_at TEXT
);

CREATE INDEX idx_draft_runs_thread ON draft_runs(thread_id, created_at DESC);
CREATE INDEX idx_draft_runs_status ON draft_runs(status, created_at);

CREATE TABLE reply_attempts (
  id TEXT PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  draft_id INTEGER REFERENCES drafts(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  text_body TEXT NOT NULL,
  to_addresses TEXT NOT NULL,
  message_id TEXT UNIQUE,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_reply_attempts_thread ON reply_attempts(thread_id, created_at DESC);

ALTER TABLE drafts ADD COLUMN source_inbound_message_id INTEGER REFERENCES messages(id) ON DELETE SET NULL;
CREATE INDEX idx_drafts_source_message ON drafts(source_inbound_message_id, status);
