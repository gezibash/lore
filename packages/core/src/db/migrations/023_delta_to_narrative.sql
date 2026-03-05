-- Rename delta → narrative throughout the schema

-- Rename table
ALTER TABLE deltas RENAME TO narratives;

-- Rename view (must drop and recreate)
DROP VIEW current_deltas;
CREATE VIEW current_narratives AS
  SELECT d.* FROM narratives d
  INNER JOIN (SELECT id, MAX(rowid) AS rid FROM narratives GROUP BY id) latest
  ON d.id = latest.id AND d.rowid = latest.rid;

-- Rename columns referencing delta_id
ALTER TABLE chunks RENAME COLUMN delta_id TO narrative_id;
ALTER TABLE concept_snapshots RENAME COLUMN delta_id TO narrative_id;
ALTER TABLE commits RENAME COLUMN delta_id TO narrative_id;

-- Recreate indexes under new names (SQLite can't rename indexes)
DROP INDEX idx_deltas_identity;
CREATE INDEX idx_narratives_identity ON narratives(id, version_id);

DROP INDEX idx_chunks_delta;
CREATE INDEX idx_chunks_narrative ON chunks(narrative_id, created_at);
