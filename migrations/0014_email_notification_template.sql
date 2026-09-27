-- Customizable email notification. NULL means the built-in default.
ALTER TABLE global_settings ADD COLUMN email_notification_from_name TEXT;
-- Inbox to send from; NULL sends from the Inbox that received the email.
ALTER TABLE global_settings ADD COLUMN email_notification_from_mailbox_id INTEGER;
ALTER TABLE global_settings ADD COLUMN email_notification_subject TEXT;
ALTER TABLE global_settings ADD COLUMN email_notification_body TEXT;
