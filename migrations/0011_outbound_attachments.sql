-- Staged outbound attachments for durable attempts. Each row stores a JSON
-- array of {filename, content_type, size, disposition, content_id, r2_key}
-- so a retried attempt can be checked for identical content and a finalized
-- message can reference the already-uploaded R2 objects.
ALTER TABLE reply_attempts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbound_attempts ADD COLUMN attachments TEXT NOT NULL DEFAULT '[]';
