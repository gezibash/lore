import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type {
  ConceptHealthSignalRow,
  ConceptHealthTopRow,
  ConceptHealthExplainResult,
} from "@/types/index.ts";

interface ConceptHealthTopRowRaw extends Omit<ConceptHealthTopRow, "critical"> {
  critical: number;
}

interface ConceptHealthExplainRowRaw {
  concept: string;
  run_id: string;
  created_at: string;
  final_stale: number;
  time_stale: number;
  ref_stale: number;
  local_graph_stale: number;
  global_shock: number;
  influence: number;
  critical_multiplier: number;
  residual_after_adjust: number;
  debt_after_adjust: number;
}

export function insertConceptHealthSignal(
  db: Database,
  signal: Omit<ConceptHealthSignalRow, "id" | "created_at">,
  createdAt?: string,
): ConceptHealthSignalRow {
  const row: ConceptHealthSignalRow = {
    id: ulid(),
    created_at: createdAt ?? new Date().toISOString(),
    ...signal,
  };

  db.query(
    `INSERT INTO concept_health_signals
       (id, run_id, concept_id, time_stale, ref_stale, local_graph_stale, global_shock, influence,
        critical_multiplier, final_stale, residual_after_adjust, debt_after_adjust, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.run_id,
    row.concept_id,
    row.time_stale,
    row.ref_stale,
    row.local_graph_stale,
    row.global_shock,
    row.influence,
    row.critical_multiplier,
    row.final_stale,
    row.residual_after_adjust,
    row.debt_after_adjust,
    row.created_at,
  );

  return row;
}

export function getCurrentConceptHealthSignal(
  db: Database,
  conceptId: string,
): ConceptHealthSignalRow | null {
  return (
    db
      .query<ConceptHealthSignalRow, [string]>(
        `SELECT id, run_id, concept_id, time_stale, ref_stale, local_graph_stale, global_shock,
                influence, critical_multiplier, final_stale, residual_after_adjust, debt_after_adjust, created_at
         FROM current_concept_health_signals
         WHERE concept_id = ?
         LIMIT 1`,
      )
      .get(conceptId) ?? null
  );
}

export function getCurrentConceptHealthSignals(db: Database): ConceptHealthSignalRow[] {
  return db
    .query<ConceptHealthSignalRow, []>(
      `SELECT id, run_id, concept_id, time_stale, ref_stale, local_graph_stale, global_shock,
              influence, critical_multiplier, final_stale, residual_after_adjust, debt_after_adjust, created_at
       FROM current_concept_health_signals
       ORDER BY final_stale DESC, created_at DESC`,
    )
    .all();
}

export function getConceptHealthSignalsForRun(
  db: Database,
  runId: string,
): ConceptHealthSignalRow[] {
  return db
    .query<ConceptHealthSignalRow, [string]>(
      `SELECT id, run_id, concept_id, time_stale, ref_stale, local_graph_stale, global_shock,
              influence, critical_multiplier, final_stale, residual_after_adjust, debt_after_adjust, created_at
       FROM concept_health_signals
       WHERE run_id = ?
       ORDER BY final_stale DESC, created_at DESC`,
    )
    .all(runId);
}

export function getLatestConceptHealthRun(
  db: Database,
): { run_id: string; created_at: string } | null {
  return (
    db
      .query<{ run_id: string; created_at: string }, []>(
        `SELECT run_id, MAX(created_at) AS created_at
         FROM concept_health_signals
         GROUP BY run_id
         ORDER BY created_at DESC
         LIMIT 1`,
      )
      .get() ?? null
  );
}

export function getTopCurrentConceptHealthRows(db: Database, limit: number): ConceptHealthTopRow[] {
  const rows = db
    .query<ConceptHealthTopRowRaw, [number]>(
      `SELECT cc.name AS concept,
              chs.final_stale,
              chs.time_stale,
              chs.ref_stale,
              chs.local_graph_stale,
              chs.global_shock,
              chs.influence,
              CASE WHEN chs.critical_multiplier > 1 THEN 1 ELSE 0 END AS critical
       FROM current_concept_health_signals chs
       JOIN current_concepts cc ON cc.id = chs.concept_id
       WHERE cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active'
       ORDER BY chs.final_stale DESC, cc.name ASC
       LIMIT ?`,
    )
    .all(Math.max(1, limit));

  return rows.map((row) => ({
    ...row,
    critical: row.critical === 1,
  }));
}

export function getConceptHealthExplainRow(
  db: Database,
  conceptId: string,
): ConceptHealthExplainResult | null {
  const row = db
    .query<ConceptHealthExplainRowRaw, [string]>(
      `SELECT cc.name AS concept,
              chs.run_id,
              chs.created_at,
              chs.final_stale,
              chs.time_stale,
              chs.ref_stale,
              chs.local_graph_stale,
              chs.global_shock,
              chs.influence,
              chs.critical_multiplier,
              chs.residual_after_adjust,
              chs.debt_after_adjust
       FROM current_concept_health_signals chs
       JOIN current_concepts cc ON cc.id = chs.concept_id
       WHERE chs.concept_id = ?
       LIMIT 1`,
    )
    .get(conceptId);

  if (!row) return null;

  return {
    concept: row.concept,
    run_id: row.run_id,
    computed_at: row.created_at,
    signal: {
      final_stale: row.final_stale,
      time_stale: row.time_stale,
      ref_stale: row.ref_stale,
      local_graph_stale: row.local_graph_stale,
      global_shock: row.global_shock,
      influence: row.influence,
      critical: row.critical_multiplier > 1,
      critical_multiplier: row.critical_multiplier,
      residual_after_adjust: row.residual_after_adjust,
      debt_after_adjust: row.debt_after_adjust,
    },
    neighbors: [],
  };
}
