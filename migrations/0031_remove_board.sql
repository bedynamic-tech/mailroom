-- The Board is removed: its Columns, Items, their Notes, Conversation links
-- and reminders are dropped, along with the Mail Rule "create a board item"
-- action and the Board reminders notification checkboxes. Conversations are
-- not touched.
ALTER TABLE mail_rules DROP COLUMN board_column_id;

ALTER TABLE global_settings DROP COLUMN browser_board_reminders;
ALTER TABLE global_settings DROP COLUMN email_board_reminders;

DROP TABLE board_card_notes;
DROP TABLE board_card_threads;
DROP TABLE board_cards;
DROP TABLE board_columns;
