ALTER TABLE incidents ADD COLUMN acknowledged_at TEXT;
ALTER TABLE incidents ADD COLUMN acknowledgement_message TEXT;

CREATE TABLE IF NOT EXISTS incident_notes (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL,
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (incident_id) REFERENCES incidents(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS incident_notes_incident_id ON incident_notes(incident_id, created_at DESC);
