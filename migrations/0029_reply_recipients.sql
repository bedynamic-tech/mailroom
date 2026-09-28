-- To, Cc and Bcc edited in a Conversation's reply box, as JSON
-- {"to": [...] | null, "cc": [...], "bcc": [...]}. NULL when nothing was
-- edited, so the reply goes to the latest inbound sender.
ALTER TABLE threads ADD COLUMN reply_recipients TEXT;
