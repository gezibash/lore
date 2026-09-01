-- 030: Runs — a record of something executed, with what it was given and what
-- it produced.
--
-- A KPI reading is one scalar over time. A run is the event behind a reading:
-- the inputs it was given, every number it produced, and the files it left. A
-- sweep, a benchmark, a migration, a deploy. Without a record for it, that
-- knowledge lives as prose in a journal entry, where it cannot be compared
-- against the run before it.
--
-- Provenance matches kpi_readings, so a run and a reading taken from it agree
-- on which narrative, which git head and which lore commit produced them.

CREATE TABLE runs (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  -- What happened. A failed run is knowledge: it records a configuration that
  -- does not work, which is the thing most often repeated by accident.
  outcome         TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'aborted')),
  -- Inputs, as a JSON object of string values. Kept as text because a
  -- parameter's type belongs to the tool that read it, not to lore.
  params_json     TEXT,
  -- Outputs, as a JSON object of numbers.
  metrics_json    TEXT,
  -- Repo-relative paths or URLs the run left behind.
  artifacts_json  TEXT,
  note            TEXT,
  narrative_id    TEXT,
  git_head        TEXT,
  lore_commit_id  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX idx_runs_name_created ON runs(name, created_at DESC);
CREATE INDEX idx_runs_created ON runs(created_at DESC);
CREATE INDEX idx_runs_narrative ON runs(narrative_id) WHERE narrative_id IS NOT NULL;
