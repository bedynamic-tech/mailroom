CREATE TABLE domains (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  activated_at TEXT
);

-- Existing Inbox addresses were already receiving mail, so their Domains are ready.
INSERT INTO domains (name, status, activated_at)
SELECT DISTINCT
  lower(substr(address, instr(address, '@') + 1)),
  'active',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM mailboxes
WHERE instr(address, '@') > 1;

ALTER TABLE mailboxes ADD COLUMN domain_id INTEGER REFERENCES domains(id) ON DELETE RESTRICT;

UPDATE mailboxes
SET domain_id = (
  SELECT id
  FROM domains
  WHERE domains.name = lower(substr(mailboxes.address, instr(mailboxes.address, '@') + 1))
);

CREATE INDEX idx_mailboxes_domain ON mailboxes(domain_id, address);
