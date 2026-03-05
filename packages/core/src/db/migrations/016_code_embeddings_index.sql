-- Unique index on (chunk_id, model) so dual-model embedding upserts work correctly.
-- A chunk may have at most one embedding per model; INSERT OR REPLACE uses this to update in place.
CREATE UNIQUE INDEX IF NOT EXISTS idx_embeddings_chunk_model
  ON embeddings(chunk_id, model);
