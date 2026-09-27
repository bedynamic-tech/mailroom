CREATE TABLE oauth_authorization_transactions (
  token_hash TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  owner_sub TEXT NOT NULL,
  auth_request_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER,
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR consumed_at >= created_at)
);

CREATE INDEX idx_oauth_authorization_transactions_expiry
  ON oauth_authorization_transactions(expires_at);
