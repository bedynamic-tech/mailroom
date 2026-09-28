-- Catch-all: one Inbox per Domain can receive mail sent to any address on
-- that Domain that has no Inbox of its own. NULL means the Domain has none,
-- so mail to unregistered addresses keeps being rejected.
ALTER TABLE domains ADD COLUMN catch_all_mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE SET NULL;

-- The address a caught Conversation was sent to (lowercased), or NULL for a
-- Conversation that reached its Inbox's own address. Replies go out from it.
ALTER TABLE threads ADD COLUMN catch_all_recipient TEXT;

CREATE INDEX idx_threads_catch_all_recipient ON threads(mailbox_id, catch_all_recipient)
  WHERE catch_all_recipient IS NOT NULL;

-- Blocked Addresses: addresses on the workspace's own Domains that the
-- catch-all rejects, for aliases that leaked to spammers. An address with its
-- own Inbox is never caught, so a rule only ever applies to catch-all mail.
CREATE TABLE blocked_recipients (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  blocked_count INTEGER NOT NULL DEFAULT 0,
  last_blocked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
