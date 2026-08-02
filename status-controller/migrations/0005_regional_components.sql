CREATE TABLE IF NOT EXISTS component_uptime_checks (
  component_id TEXT NOT NULL,
  operational INTEGER NOT NULL CHECK (operational IN (0, 1)),
  planned_maintenance INTEGER NOT NULL DEFAULT 0 CHECK (planned_maintenance IN (0, 1)),
  recorded_at TEXT NOT NULL,
  PRIMARY KEY (component_id, recorded_at)
);

CREATE INDEX IF NOT EXISTS component_uptime_recorded_at
  ON component_uptime_checks(recorded_at);

CREATE INDEX IF NOT EXISTS component_uptime_component_time
  ON component_uptime_checks(component_id, recorded_at);

-- A monitor run can outlive the one-minute cron interval while it waits for
-- canaries or a protected failover hook. This lease serializes cron and
-- operator transitions so they cannot race writer claims or DNS updates.
CREATE TABLE IF NOT EXISTS status_monitor_leases (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS status_monitor_leases_expiry
  ON status_monitor_leases(expires_at);
