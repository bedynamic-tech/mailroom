-- Blocked Senders: workspace-wide rules that reject inbound mail before it
-- is stored. A rule is either one exact address or a domain; a domain rule
-- also covers its subdomains (blocking example.com blocks mail.example.com).
CREATE TABLE blocked_senders (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('address', 'domain')),
  -- Lowercased address or domain, without a leading "@".
  pattern TEXT NOT NULL UNIQUE COLLATE NOCASE,
  -- How many inbound emails this rule has rejected, and when it last did.
  blocked_count INTEGER NOT NULL DEFAULT 0,
  last_blocked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
