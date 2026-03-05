CREATE TABLE query_cache (
  id              TEXT PRIMARY KEY,
  query_text      TEXT NOT NULL,
  query_embedding BLOB,
  result_json     TEXT NOT NULL,
  score           REAL,
  scored_by       TEXT,
  scored_at       TEXT,
  created_at      TEXT NOT NULL,
  expires_at      TEXT
);

CREATE INDEX idx_query_cache_created ON query_cache(created_at);
CREATE INDEX idx_query_cache_score ON query_cache(score) WHERE score IS NOT NULL;
