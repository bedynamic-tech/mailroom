-- A Blocked Sender can now apply to one Inbox instead of the whole workspace.
-- NULL mailbox_id keeps the rule for all Inboxes. The same pattern may be
-- blocked once per Inbox and once for all Inboxes, so uniqueness moves from
-- the pattern alone to the pattern and scope.
CREATE TABLE blocked_senders_new (
  id INTEGER PRIMARY KEY,
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  pattern TEXT NOT NULL COLLATE NOCASE,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  last_blocked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO blocked_senders_new (id, mailbox_id, kind, pattern, blocked_count, last_blocked_at, created_at)
SELECT id, NULL, kind, pattern, blocked_count, last_blocked_at, created_at FROM blocked_senders;

DROP TABLE blocked_senders;
ALTER TABLE blocked_senders_new RENAME TO blocked_senders;

CREATE UNIQUE INDEX idx_blocked_senders_scope ON blocked_senders(pattern, COALESCE(mailbox_id, 0));
CREATE INDEX idx_blocked_senders_mailbox ON blocked_senders(mailbox_id);
