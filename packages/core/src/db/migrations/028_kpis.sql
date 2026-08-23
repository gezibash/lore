-- 028: KPIs — named scalar timeseries with goals, tied to provenance.
-- A reading records what was measured, when, and under which narrative /
-- git head / lore commit, so progress can be explained, not just plotted.
-- Goals are append-only versions; the current goal is the latest row.

CREATE TABLE kpis (
  name        TEXT PRIMARY KEY,
  unit        TEXT,
  direction   TEXT NOT NULL CHECK (direction IN ('up', 'down')),
  note        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE kpi_goals (
  id          TEXT PRIMARY KEY,
  kpi_name    TEXT NOT NULL REFERENCES kpis(name) ON DELETE CASCADE,
  target      REAL NOT NULL,
  set_at      TEXT NOT NULL
);

CREATE INDEX idx_kpi_goals_kpi ON kpi_goals(kpi_name, set_at DESC);

CREATE VIEW current_kpi_goals AS
  SELECT g.* FROM kpi_goals g
  INNER JOIN (SELECT kpi_name, MAX(rowid) AS rid FROM kpi_goals GROUP BY kpi_name) latest
  ON g.kpi_name = latest.kpi_name AND g.rowid = latest.rid;

CREATE TABLE kpi_readings (
  id              TEXT PRIMARY KEY,
  kpi_name        TEXT NOT NULL REFERENCES kpis(name) ON DELETE CASCADE,
  value           REAL NOT NULL,
  narrative_id    TEXT,
  git_head        TEXT,
  lore_commit_id  TEXT,
  meta_json       TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_kpi_readings_kpi_created ON kpi_readings(kpi_name, created_at DESC);
CREATE INDEX idx_kpi_readings_narrative ON kpi_readings(narrative_id) WHERE narrative_id IS NOT NULL;
