-- One row per recipient of an outbound Message that a returned bounce notice
-- reported as undeliverable, so a Cc that bounces is told apart from a To that
-- was delivered. bounce_message_id is the stored inbound bounce notice itself.
CREATE TABLE message_bounces (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  recipient TEXT NOT NULL COLLATE NOCASE,
  -- Enhanced status code such as 5.1.1, when the notice gave one.
  status TEXT,
  -- The receiving server's explanation, shown when hovering the bounce mark.
  diagnostic TEXT NOT NULL DEFAULT '',
  bounce_message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (message_id, recipient)
);

CREATE INDEX idx_message_bounces_bounce ON message_bounces(bounce_message_id);
