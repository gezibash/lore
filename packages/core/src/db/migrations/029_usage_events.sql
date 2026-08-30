-- 029: usage events — what each AI call spent, per lore.
-- Providers report token counts on every response and lore threw them away, so
-- there was no way to say what a project had cost. Tokens are recorded here;
-- money is not, because a price is a property of the model on the day you ask,
-- not of the call. Cost is computed at report time from the live catalog.
-- kind separates generation from embedding, whose prices differ by orders of
-- magnitude. operation is the reasoning scope the call ran under, so spend
-- attributes to close, ask, or ingest rather than to one undifferentiated total.

CREATE TABLE usage_events (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL CHECK (kind IN ('generation', 'embedding')),
  operation      TEXT NOT NULL,
  provider       TEXT NOT NULL,
  model          TEXT NOT NULL,
  input_tokens   INTEGER NOT NULL DEFAULT 0,
  output_tokens  INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL
);

CREATE INDEX idx_usage_events_created ON usage_events(created_at DESC);
CREATE INDEX idx_usage_events_model ON usage_events(model, created_at DESC);
CREATE INDEX idx_usage_events_operation ON usage_events(operation, created_at DESC);
