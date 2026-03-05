CREATE TABLE concept_health_signals (
  id                   TEXT PRIMARY KEY,
  run_id               TEXT NOT NULL,
  concept_id           TEXT NOT NULL,
  time_stale           REAL NOT NULL,
  ref_stale            REAL NOT NULL,
  local_graph_stale    REAL NOT NULL,
  global_shock         REAL NOT NULL,
  influence            REAL NOT NULL,
  critical_multiplier  REAL NOT NULL,
  final_stale          REAL NOT NULL,
  residual_after_adjust REAL NOT NULL,
  debt_after_adjust    REAL NOT NULL,
  created_at           TEXT NOT NULL
);

CREATE INDEX idx_chs_concept_created ON concept_health_signals(concept_id, created_at DESC);
CREATE INDEX idx_chs_run ON concept_health_signals(run_id);
CREATE INDEX idx_chs_final_stale ON concept_health_signals(final_stale DESC);

CREATE VIEW current_concept_health_signals AS
  SELECT chs.* FROM concept_health_signals chs
  INNER JOIN (
    SELECT concept_id, MAX(rowid) AS rid
    FROM concept_health_signals
    GROUP BY concept_id
  ) latest
  ON chs.concept_id = latest.concept_id AND chs.rowid = latest.rid;
