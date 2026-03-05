CREATE TABLE call_sites (
  id              TEXT PRIMARY KEY,
  source_file_id  TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  callee_name     TEXT NOT NULL,
  caller_name     TEXT,
  line            INTEGER NOT NULL,
  snippet         TEXT,
  scanned_at      TEXT NOT NULL
);

CREATE INDEX idx_call_sites_callee ON call_sites(callee_name);
CREATE INDEX idx_call_sites_caller ON call_sites(caller_name);
CREATE INDEX idx_call_sites_source_file ON call_sites(source_file_id);
