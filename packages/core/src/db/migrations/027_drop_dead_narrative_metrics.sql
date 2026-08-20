-- 027: drop theta / magnitude / convergence from narratives.
-- Always null in practice; knowledge-model spec §6 removes them from the
-- schema. SQLite table rebuild: the table is append-only versioned, so every
-- row is preserved. current_narratives (a view over the table) is recreated
-- unchanged; it selects d.* so it follows the new column set automatically.

CREATE TABLE narratives_new (
  version_id            TEXT PRIMARY KEY,
  id                    TEXT NOT NULL,
  name                  TEXT NOT NULL,
  intent                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'open',
  entry_count           INTEGER DEFAULT 0,
  merge_base_commit_id  TEXT,
  opened_at             TEXT NOT NULL,
  closed_at             TEXT,
  inserted_at           TEXT NOT NULL,
  targets               TEXT
);

INSERT INTO narratives_new (version_id, id, name, intent, status, entry_count,
                            merge_base_commit_id, opened_at, closed_at,
                            inserted_at, targets)
SELECT version_id, id, name, intent, status, entry_count,
       merge_base_commit_id, opened_at, closed_at, inserted_at, targets
FROM narratives;

DROP VIEW IF EXISTS current_narratives;
DROP TABLE narratives;
ALTER TABLE narratives_new RENAME TO narratives;

CREATE INDEX idx_narratives_identity ON narratives(id, version_id);

CREATE VIEW current_narratives AS
  SELECT d.* FROM narratives d
  INNER JOIN (SELECT id, MAX(rowid) AS rid FROM narratives GROUP BY id) latest
  ON d.id = latest.id AND d.rowid = latest.rid;
