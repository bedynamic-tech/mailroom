-- Mail Rules gain a "create a board item" action: a Card in this Column,
-- titled from the email's subject and linked to its Conversation. Deleting
-- the Column turns the action off.
ALTER TABLE mail_rules ADD COLUMN board_column_id INTEGER REFERENCES board_columns(id) ON DELETE SET NULL;
