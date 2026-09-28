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

-- Whether Browser and Email Notifications, while on, also carry Board Reminders.
ALTER TABLE global_settings ADD COLUMN browser_board_reminders INTEGER NOT NULL DEFAULT 1
  CHECK (browser_board_reminders IN (0, 1));
ALTER TABLE global_settings ADD COLUMN email_board_reminders INTEGER NOT NULL DEFAULT 1
  CHECK (email_board_reminders IN (0, 1));
