-- Reply greeting: when on, a Conversation's reply box starts with a greeting
-- line such as "Jane," and a blank line. The template is plain text; NULL
-- uses the built-in default "{first_name},".
ALTER TABLE global_settings ADD COLUMN reply_greeting_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (reply_greeting_enabled IN (0, 1));
ALTER TABLE global_settings ADD COLUMN reply_greeting_template TEXT;
