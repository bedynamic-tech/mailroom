-- Carbon-copy recipients for outbound mail. Inbound messages already record
-- cc_addresses; bcc_addresses is only ever known for mail sent from Mailroom.
ALTER TABLE messages ADD COLUMN bcc_addresses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reply_attempts ADD COLUMN cc_addresses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE reply_attempts ADD COLUMN bcc_addresses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbound_attempts ADD COLUMN cc_addresses TEXT NOT NULL DEFAULT '[]';
ALTER TABLE outbound_attempts ADD COLUMN bcc_addresses TEXT NOT NULL DEFAULT '[]';
