ALTER TABLE chunks ADD COLUMN concept_designations TEXT; -- JSON array of concept names/designations

CREATE TABLE close_maintenance_jobs (
  id               TEXT PRIMARY KEY,
  lore_path        TEXT NOT NULL,
  narrative_id     TEXT NOT NULL,
  narrative_name   TEXT NOT NULL,
  commit_id        TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  owner            TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error       TEXT,
  payload_json     TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX idx_close_maintenance_status
  ON close_maintenance_jobs(lore_path, status, lease_expires_at, updated_at);

CREATE INDEX idx_close_maintenance_commit
  ON close_maintenance_jobs(lore_path, commit_id);
