-- Labels: per-Inbox auto-tagging rules evaluated on new inbound mail.
-- A Label names an audience or intent (e.g. guest-post, link-exchange) and
-- carries the natural-language condition the evaluation model matches against.
CREATE TABLE labels (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id),
  name TEXT NOT NULL,
  condition TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE UNIQUE INDEX idx_labels_mailbox_name ON labels(mailbox_id, name COLLATE NOCASE);

-- A Conversation can carry any number of Labels.
CREATE TABLE thread_labels (
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  label_id INTEGER NOT NULL REFERENCES labels(id),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (thread_id, label_id)
);

CREATE INDEX idx_thread_labels_label ON thread_labels(label_id, thread_id);
