-- Board Item due dates and reminders.
-- due_at is UTC; due_time_zone is the IANA zone it was picked in, so reminder
-- emails show the time the way it was entered.
ALTER TABLE board_cards ADD COLUMN due_at TEXT;
ALTER TABLE board_cards ADD COLUMN due_time_zone TEXT;
-- Minutes before due_at to remind (0 = at the due time); NULL means no reminder.
ALTER TABLE board_cards ADD COLUMN reminder_minutes INTEGER;
-- due_at minus reminder_minutes, kept so the scheduler can find due reminders.
ALTER TABLE board_cards ADD COLUMN remind_at TEXT;
-- Set once the reminder went out (or was never due), so it is sent at most once.
ALTER TABLE board_cards ADD COLUMN reminder_sent_at TEXT;

CREATE INDEX idx_board_cards_remind_at ON board_cards(remind_at)
  WHERE remind_at IS NOT NULL AND reminder_sent_at IS NULL;

-- How reminders are delivered: to subscribed browsers, by email, or both.
ALTER TABLE global_settings ADD COLUMN board_reminder_channels TEXT NOT NULL DEFAULT 'browser'
  CHECK (board_reminder_channels IN ('browser', 'email', 'both'));
ALTER TABLE global_settings ADD COLUMN board_reminder_address TEXT;
-- Web origin captured when the setting is saved, used to link to the item.
ALTER TABLE global_settings ADD COLUMN board_reminder_origin TEXT;
