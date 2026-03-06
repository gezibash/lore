CREATE TABLE close_jobs (
  id                TEXT PRIMARY KEY,
  lore_path         TEXT NOT NULL,
  narrative_id      TEXT NOT NULL,
  narrative_name    TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'queued',
  owner             TEXT,
  attempt           INTEGER NOT NULL DEFAULT 0,
  lease_expires_at  TEXT,
  last_error        TEXT,
  payload_json      TEXT NOT NULL,
  close_result_json TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  completed_at      TEXT
);

CREATE INDEX idx_close_jobs_status
  ON close_jobs(lore_path, status, lease_expires_at, updated_at);

CREATE INDEX idx_close_jobs_narrative
  ON close_jobs(lore_path, narrative_id, status, updated_at);
