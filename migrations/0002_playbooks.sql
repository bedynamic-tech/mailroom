CREATE TABLE playbooks (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  when_to_use TEXT NOT NULL,
  instructions TEXT NOT NULL,
  example_reply TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_playbooks_mailbox ON playbooks(mailbox_id, enabled, updated_at DESC);

ALTER TABLE drafts ADD COLUMN playbook_id INTEGER REFERENCES playbooks(id) ON DELETE SET NULL;
CREATE INDEX idx_drafts_playbook ON drafts(playbook_id);
