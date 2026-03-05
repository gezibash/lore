CREATE TABLE concept_relations (
  id               TEXT PRIMARY KEY,
  from_concept_id  TEXT NOT NULL,
  to_concept_id    TEXT NOT NULL,
  relation_type    TEXT NOT NULL,
  weight           REAL NOT NULL DEFAULT 1.0,
  active           INTEGER NOT NULL DEFAULT 1,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE INDEX idx_rel_from_active ON concept_relations(from_concept_id, active);
CREATE INDEX idx_rel_to_active ON concept_relations(to_concept_id, active);
CREATE INDEX idx_rel_type_active ON concept_relations(relation_type, active);
