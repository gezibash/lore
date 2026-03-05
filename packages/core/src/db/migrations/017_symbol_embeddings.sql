-- Per-symbol code embeddings for code-lane vector search.
-- Symbols are not chunks — they need their own embedding storage.
-- Text model embeds concept prose (in embeddings table); code model embeds symbol source (here).
CREATE TABLE IF NOT EXISTS symbol_embeddings (
  id TEXT PRIMARY KEY,
  symbol_id TEXT NOT NULL,
  embedding BLOB NOT NULL,
  model TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_symbol_embeddings_symbol_model
  ON symbol_embeddings(symbol_id, model);
