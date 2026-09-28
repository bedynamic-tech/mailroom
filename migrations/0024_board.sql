-- Board: one workspace-wide Kanban board. Columns are ordered left to right
-- by position; Cards are ordered top to bottom within their Column.
CREATE TABLE board_columns (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE board_cards (
  id INTEGER PRIMARY KEY,
  column_id INTEGER NOT NULL REFERENCES board_columns(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX idx_board_cards_column ON board_cards(column_id, position, id);

-- Links between Cards and the Conversations they are about. A Card can link
-- several Conversations and a Conversation can appear on several Cards.
CREATE TABLE board_card_threads (
  card_id INTEGER NOT NULL REFERENCES board_cards(id) ON DELETE CASCADE,
  thread_id INTEGER NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (card_id, thread_id)
);

CREATE INDEX idx_board_card_threads_thread ON board_card_threads(thread_id);

INSERT INTO board_columns (name, position) VALUES
  ('To do', 0),
  ('In progress', 1),
  ('Done', 2);
