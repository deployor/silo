CREATE TABLE bootstrap_sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  report_token_hash TEXT NOT NULL UNIQUE,
  incident_id TEXT,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  exchanged_at TEXT,
  reported_at TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX bootstrap_sessions_expiry_idx ON bootstrap_sessions(expires_at);
