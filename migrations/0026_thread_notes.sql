-- Internal Notes: rich-text notes people leave on a Conversation for each
-- other. They live apart from messages so no send, quote, forward, draft or
-- notification path can ever pick one up.
CREATE TABLE thread_notes (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  text_body TEXT NOT NULL,
  html_body TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_thread_notes_thread ON thread_notes(thread_id, created_at, id);
