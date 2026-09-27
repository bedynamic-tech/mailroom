-- Mailboxes: each customer-facing address is a first-class entity.
-- The unified inbox is a query across all of them.
CREATE TABLE mailboxes (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  color TEXT NOT NULL DEFAULT '#6366f1',
  agent_mode TEXT NOT NULL DEFAULT 'off' CHECK (agent_mode IN ('off', 'draft', 'auto')),
  agent_instructions TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  subject TEXT NOT NULL DEFAULT '',
  normalized_subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'archived', 'needs_human')),
  is_read INTEGER NOT NULL DEFAULT 0,
  message_count INTEGER NOT NULL DEFAULT 0,
  last_message_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_threads_mailbox ON threads(mailbox_id, status, last_message_at DESC);
CREATE INDEX idx_threads_status ON threads(status, last_message_at DESC);
CREATE INDEX idx_threads_subject ON threads(mailbox_id, normalized_subject);

CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  -- RFC 5322 Message-ID; unique constraint doubles as the inbound dedup key
  message_id TEXT NOT NULL UNIQUE,
  in_reply_to TEXT,
  references_ids TEXT NOT NULL DEFAULT '[]',
  direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  sent_by TEXT NOT NULL DEFAULT 'external' CHECK (sent_by IN ('external', 'human', 'agent')),
  from_address TEXT NOT NULL,
  from_name TEXT,
  to_addresses TEXT NOT NULL DEFAULT '[]',
  cc_addresses TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  text_body TEXT,
  html_body TEXT,
  -- R2 object key of the raw MIME source
  raw_key TEXT,
  -- Set when the sender marked the mail as automated (Auto-Submitted, Precedence: bulk/list).
  -- The agent must never auto-reply to these.
  is_auto_submitted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);

-- Agent-authored (or human-saved) drafts pending review in the web UI
CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  text_body TEXT NOT NULL,
  created_by TEXT NOT NULL DEFAULT 'human' CHECK (created_by IN ('human', 'agent')),
  -- The agent's reasoning trace, shown to the reviewer
  agent_notes TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'discarded')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_drafts_thread ON drafts(thread_id, status);

CREATE VIRTUAL TABLE messages_fts USING fts5(
  subject,
  text_body,
  content='messages',
  content_rowid='id'
);

CREATE TRIGGER messages_fts_insert AFTER INSERT ON messages BEGIN
  INSERT INTO messages_fts(rowid, subject, text_body)
  VALUES (new.id, new.subject, new.text_body);
END;

CREATE TRIGGER messages_fts_delete AFTER DELETE ON messages BEGIN
  INSERT INTO messages_fts(messages_fts, rowid, subject, text_body)
  VALUES ('delete', old.id, old.subject, old.text_body);
END;
