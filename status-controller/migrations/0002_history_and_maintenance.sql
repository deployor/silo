CREATE TABLE IF NOT EXISTS uptime_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  s3_operational INTEGER NOT NULL CHECK (s3_operational IN (0, 1)),
  dashboard_operational INTEGER NOT NULL CHECK (dashboard_operational IN (0, 1)),
  recorded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS uptime_checks_recorded_at ON uptime_checks(recorded_at);

CREATE TABLE IF NOT EXISTS maintenance_windows (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS maintenance_windows_ends_at ON maintenance_windows(ends_at);
