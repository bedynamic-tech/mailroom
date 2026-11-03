-- What blocking a sender from a Conversation does to the mail they already
-- sent: 'archive' files their Conversations in the Archive (the earlier
-- behavior), 'permanent_delete' removes them for good.
ALTER TABLE global_settings ADD COLUMN blocked_sender_action TEXT NOT NULL DEFAULT 'archive'
  CHECK (blocked_sender_action IN ('archive', 'permanent_delete'));
