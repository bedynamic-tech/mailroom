-- On/off switch kept separate from the address, so turning email
-- notifications off keeps the address for turning them back on.
ALTER TABLE global_settings ADD COLUMN email_notifications_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (email_notifications_enabled IN (0, 1));

UPDATE global_settings SET email_notifications_enabled = 1
WHERE email_notification_address IS NOT NULL;
