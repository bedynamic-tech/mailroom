-- Email signatures. The workspace default applies to every Inbox whose
-- signature_mode is 'default'; 'custom' uses the Inbox's own signature and
-- 'none' sends without one. Signatures are stored as sanitized HTML.
ALTER TABLE global_settings ADD COLUMN default_signature_html TEXT;

ALTER TABLE mailboxes ADD COLUMN signature_mode TEXT NOT NULL DEFAULT 'default'
  CHECK (signature_mode IN ('default', 'custom', 'none'));
ALTER TABLE mailboxes ADD COLUMN signature_html TEXT;

-- The signature in effect when an attempt was created, so a retry sends the
-- same email even if the signature settings change in between.
ALTER TABLE reply_attempts ADD COLUMN signature_html TEXT;
ALTER TABLE outbound_attempts ADD COLUMN signature_html TEXT;

-- Rich-text message bodies (sanitized HTML). text_body keeps the plain-text
-- version derived from it; NULL means the message was written as plain text.
ALTER TABLE reply_attempts ADD COLUMN html_body TEXT;
ALTER TABLE outbound_attempts ADD COLUMN html_body TEXT;
