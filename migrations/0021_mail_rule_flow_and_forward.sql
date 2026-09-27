-- Mail Rules move from four fixed conditions to a JSON condition tree
-- ({"match": "all"|"any", "items": [condition | group]}) and gain a
-- forward action with To, Cc and Bcc recipients.
ALTER TABLE mail_rules ADD COLUMN conditions TEXT NOT NULL DEFAULT '{"match":"all","items":[]}';
ALTER TABLE mail_rules ADD COLUMN forward_to TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mail_rules ADD COLUMN forward_cc TEXT NOT NULL DEFAULT '[]';
ALTER TABLE mail_rules ADD COLUMN forward_bcc TEXT NOT NULL DEFAULT '[]';

-- Carry each existing condition over. The old From condition matched an
-- exact address, a domain with its subdomains, or text in the sender.
UPDATE mail_rules SET conditions = json_object(
  'match', 'all',
  'items', (
    SELECT json_group_array(json(value)) FROM json_each(json_array(
      CASE
        WHEN from_pattern IS NULL THEN NULL
        WHEN from_pattern LIKE '_%@_%.%' AND instr(from_pattern, ' ') = 0 THEN
          json_object('field', 'from', 'operator', 'is', 'value', lower(from_pattern))
        WHEN instr(from_pattern, '.') > 0 AND instr(from_pattern, ' ') = 0
          AND instr(ltrim(replace(from_pattern, '*.', ''), '@'), '@') = 0 THEN
          json_object('field', 'from', 'operator', 'domain_is',
            'value', lower(rtrim(ltrim(replace(from_pattern, '*.', ''), '@'), '.')))
        ELSE json_object('field', 'from', 'operator', 'contains', 'value', from_pattern)
      END,
      CASE WHEN subject_contains IS NOT NULL THEN
        json_object('field', 'subject', 'operator', 'contains', 'value', subject_contains) END,
      CASE WHEN body_contains IS NOT NULL THEN
        json_object('field', 'body', 'operator', 'contains', 'value', body_contains) END,
      CASE WHEN has_attachment = 1 THEN
        json_object('field', 'has_attachment', 'operator', 'yes', 'value', '') END
    ))
    WHERE type = 'object'
  )
);

ALTER TABLE mail_rules DROP COLUMN from_pattern;
ALTER TABLE mail_rules DROP COLUMN subject_contains;
ALTER TABLE mail_rules DROP COLUMN body_contains;
ALTER TABLE mail_rules DROP COLUMN has_attachment;

-- One row per forward a rule sends for one inbound Message. The unique key
-- makes a redelivered email never forward twice.
CREATE TABLE mail_rule_forwards (
  id INTEGER PRIMARY KEY,
  rule_id INTEGER NOT NULL REFERENCES mail_rules(id) ON DELETE CASCADE,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'sending' CHECK (status IN ('sending', 'sent', 'failed')),
  provider_message_id TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (rule_id, message_id)
);

CREATE INDEX idx_mail_rule_forwards_message ON mail_rule_forwards(message_id);
