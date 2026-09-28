-- Internal Notes: rich-text notes people leave on a Conversation for each
-- other. They live apart from messages so no send, quote, forward, draft or
-- notification path can ever pick one up.
CREATE TABLE thread_notes (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text_body TEXT NOT NULL,
  html_body TEXT,
  -- The Mail Rule that added the note, or NULL when a person wrote it.
  mail_rule_id INTEGER REFERENCES mail_rules(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_thread_notes_thread ON thread_notes(thread_id, created_at, id);

-- Mail Rules gain an "add a note" action: this plain text becomes an
-- Internal Note on each matching email's Conversation.
ALTER TABLE mail_rules ADD COLUMN note TEXT;
