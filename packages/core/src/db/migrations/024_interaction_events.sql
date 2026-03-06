CREATE TABLE interaction_events (
  id         TEXT PRIMARY KEY,
  result_id  TEXT,
  event_type TEXT NOT NULL,
  subject    TEXT,
  meta_json  TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_interaction_events_created_at ON interaction_events(created_at);
CREATE INDEX idx_interaction_events_result_id ON interaction_events(result_id) WHERE result_id IS NOT NULL;
CREATE INDEX idx_interaction_events_event_type ON interaction_events(event_type, created_at);
