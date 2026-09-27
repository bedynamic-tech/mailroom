-- Workspace-wide email notification for new inbound email. NULL means off.
ALTER TABLE global_settings ADD COLUMN email_notification_address TEXT;

-- Web origin captured when the setting is saved, used to link to the conversation.
ALTER TABLE global_settings ADD COLUMN email_notification_origin TEXT;
