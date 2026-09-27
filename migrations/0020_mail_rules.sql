-- Mail Rules: deterministic filters evaluated on every stored inbound Message.
-- Every condition that is set must match; a rule with no conditions is
-- refused by the API. Matching rules' actions are combined.
CREATE TABLE mail_rules (
  id INTEGER PRIMARY KEY,
  -- The Inbox this rule applies to, or NULL for all Inboxes.
  mailbox_id INTEGER REFERENCES mailboxes(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,

  -- Conditions. NULL means "any".
  -- An address, a domain (also covering subdomains), or text found in the
  -- sender's name or address.
  from_pattern TEXT,
  subject_contains TEXT,
  body_contains TEXT,
  -- 1 requires at least one attachment (inline images do not count).
  has_attachment INTEGER NOT NULL DEFAULT 0,

  -- Actions.
  -- Only allowed on a rule for one Inbox, naming a Label of that Inbox.
  label_id INTEGER REFERENCES labels(id) ON DELETE SET NULL,
  mark_read INTEGER NOT NULL DEFAULT 0,
  archive INTEGER NOT NULL DEFAULT 0,
  skip_draft INTEGER NOT NULL DEFAULT 0,
  skip_notifications INTEGER NOT NULL DEFAULT 0,

  -- How many inbound emails this rule has matched, and when it last did.
  match_count INTEGER NOT NULL DEFAULT 0,
  last_matched_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_mail_rules_mailbox ON mail_rules(mailbox_id);
