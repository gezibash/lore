CREATE TABLE concept_heal_leases (
  lore_path        TEXT NOT NULL,
  run_id           TEXT NOT NULL,
  concept_id       TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'queued',
  owner            TEXT,
  attempt          INTEGER NOT NULL DEFAULT 0,
  lease_expires_at TEXT,
  last_error       TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (lore_path, run_id, concept_id)
);

CREATE INDEX idx_chl_status_lookup
  ON concept_heal_leases(lore_path, run_id, status, lease_expires_at, updated_at);
CREATE INDEX idx_chl_owner_lookup ON concept_heal_leases(lore_path, run_id, owner);
