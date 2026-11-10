-- Changing who a Conversation is with (for example a forwarded email that
-- arrived from the user's own address) rewrites the sender of its received
-- Messages. The sender as received is kept here so it can be shown and
-- restored. original_from_address is NULL on Messages that were never changed.
ALTER TABLE messages ADD COLUMN original_from_address TEXT;
ALTER TABLE messages ADD COLUMN original_from_name TEXT;
ALTER TABLE messages ADD COLUMN original_reply_to_addresses TEXT;
