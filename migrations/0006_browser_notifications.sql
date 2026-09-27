CREATE TABLE global_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  browser_notifications_enabled INTEGER NOT NULL DEFAULT 0
    CHECK (browser_notifications_enabled IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

INSERT INTO global_settings (id, browser_notifications_enabled) VALUES (1, 0);

CREATE TABLE push_subscriptions (
  id INTEGER PRIMARY KEY,
  endpoint TEXT NOT NULL UNIQUE,
  expiration_time INTEGER,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_push_subscriptions_updated ON push_subscriptions(updated_at DESC);
