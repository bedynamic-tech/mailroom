-- Mail Rules gain a permanent delete action: a matching inbound email is
-- dropped on arrival and nothing of it is stored.
ALTER TABLE mail_rules ADD COLUMN permanent_delete INTEGER NOT NULL DEFAULT 0
  CHECK (permanent_delete IN (0, 1));
