ALTER TABLE reply_attempts ADD COLUMN inbound_message_id INTEGER REFERENCES messages(id) ON DELETE RESTRICT;
CREATE INDEX idx_reply_attempts_inbound_message ON reply_attempts(inbound_message_id);
