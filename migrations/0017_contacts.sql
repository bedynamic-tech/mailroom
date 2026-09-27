-- Contacts: workspace-wide details about the people who email the Inboxes.
-- A Contact is recorded automatically the first time an external sender's
-- mail arrives, and can also be added or edited by hand. The address is the
-- Contact's identity; messages are matched to it by sender address.
CREATE TABLE contacts (
  id INTEGER PRIMARY KEY,
  address TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  company TEXT,
  phone TEXT,
  notes TEXT,
  last_seen_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_contacts_recent ON contacts(COALESCE(last_seen_at, created_at) DESC, id DESC);
CREATE INDEX idx_messages_from_address ON messages(from_address COLLATE NOCASE, direction);

-- Workspace-wide switch for creating Contacts from inbound senders whose
-- name could be parsed from the From header. On by default.
ALTER TABLE global_settings ADD COLUMN auto_create_contacts INTEGER NOT NULL DEFAULT 1;

-- Backfill from existing inbound mail, applying the same rule as new mail:
-- only senders with a parsed name become Contacts, named by their latest name.
INSERT INTO contacts (address, name, last_seen_at)
SELECT address, name, last_seen_at
FROM (
  SELECT sender.address,
         (SELECT trim(named.from_name) FROM messages named
          WHERE named.direction = 'inbound' AND named.is_auto_submitted = 0
            AND named.from_address = sender.address COLLATE NOCASE
            AND trim(COALESCE(named.from_name, '')) <> ''
          ORDER BY named.created_at DESC, named.id DESC LIMIT 1) AS name,
         sender.last_seen_at
  FROM (
    SELECT lower(msg.from_address) AS address, MAX(msg.created_at) AS last_seen_at
    FROM messages msg
    WHERE msg.direction = 'inbound'
      AND msg.is_auto_submitted = 0
      AND msg.from_address LIKE '_%@_%'
      AND NOT EXISTS (SELECT 1 FROM mailboxes m WHERE m.address = msg.from_address)
    GROUP BY lower(msg.from_address)
  ) sender
)
WHERE name IS NOT NULL;
