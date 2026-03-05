CREATE TABLE concept_symbols (
  id              TEXT PRIMARY KEY,
  concept_id      TEXT NOT NULL,
  symbol_id       TEXT NOT NULL,
  binding_type    TEXT NOT NULL,
  bound_body_hash TEXT,
  confidence      REAL NOT NULL DEFAULT 1.0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_concept_symbols_pair ON concept_symbols(concept_id, symbol_id);
CREATE INDEX idx_concept_symbols_concept ON concept_symbols(concept_id);
CREATE INDEX idx_concept_symbols_symbol ON concept_symbols(symbol_id);
