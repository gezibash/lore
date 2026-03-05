CREATE TABLE source_files (
  id            TEXT PRIMARY KEY,
  file_path     TEXT NOT NULL UNIQUE,
  language      TEXT NOT NULL,
  content_hash  TEXT NOT NULL,
  size_bytes    INTEGER NOT NULL,
  symbol_count  INTEGER NOT NULL DEFAULT 0,
  scanned_at    TEXT NOT NULL
);

CREATE TABLE symbols (
  id              TEXT PRIMARY KEY,
  source_file_id  TEXT NOT NULL REFERENCES source_files(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  qualified_name  TEXT NOT NULL,
  kind            TEXT NOT NULL,
  parent_id       TEXT,
  line_start      INTEGER NOT NULL,
  line_end        INTEGER NOT NULL,
  signature       TEXT,
  body_hash       TEXT,
  export_status   TEXT,
  scanned_at      TEXT NOT NULL
);

CREATE VIRTUAL TABLE symbol_fts USING fts5(
  name, qualified_name, signature,
  symbol_id UNINDEXED,
  source_file_path UNINDEXED
);

CREATE INDEX idx_symbols_source_file ON symbols(source_file_id);
CREATE INDEX idx_symbols_kind ON symbols(kind);
CREATE INDEX idx_symbols_parent ON symbols(parent_id);
CREATE INDEX idx_symbols_name ON symbols(name);
CREATE INDEX idx_source_files_language ON source_files(language);
