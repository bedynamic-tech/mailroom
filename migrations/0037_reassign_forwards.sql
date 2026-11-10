-- When an email that starts a new Conversation is a forward, switch the
-- Conversation to the original sender named in its forwarded header. On by
-- default; the sender as received is kept in messages.original_from_*.
ALTER TABLE global_settings ADD COLUMN reassign_forwards INTEGER NOT NULL DEFAULT 1;
