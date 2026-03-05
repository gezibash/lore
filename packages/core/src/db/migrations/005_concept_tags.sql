CREATE TABLE concept_tags (
  id          TEXT PRIMARY KEY,
  concept_id  TEXT NOT NULL,
  tag         TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_concept_tags_unique ON concept_tags(concept_id, tag);
CREATE INDEX idx_concept_tags_concept ON concept_tags(concept_id);
