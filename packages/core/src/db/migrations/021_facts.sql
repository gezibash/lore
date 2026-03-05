-- Facts table for extracted structured claims from source/docs
CREATE TABLE IF NOT EXISTS facts (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  content           TEXT NOT NULL,
  content_hash      TEXT NOT NULL,
  source_path       TEXT,
  source_line_start INTEGER,
  source_line_end   INTEGER,
  captured_at       TEXT NOT NULL,
  stale             INTEGER DEFAULT 0,
  stale_checked_at  TEXT,
  metadata          TEXT
);

CREATE TABLE IF NOT EXISTS fact_links (
  id          TEXT PRIMARY KEY,
  fact_id     TEXT NOT NULL REFERENCES facts(id) ON DELETE CASCADE,
  dim_type    TEXT NOT NULL,
  dim_id      TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
