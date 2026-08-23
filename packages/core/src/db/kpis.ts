import type { Database } from "bun:sqlite";
import { ulid } from "ulid";

export type KpiDirection = "up" | "down";

export interface KpiRow {
  name: string;
  unit: string | null;
  direction: KpiDirection;
  note: string | null;
  created_at: string;
}

export interface KpiGoalRow {
  id: string;
  kpi_name: string;
  target: number;
  set_at: string;
}

export interface KpiReadingRow {
  id: string;
  kpi_name: string;
  value: number;
  narrative_id: string | null;
  git_head: string | null;
  lore_commit_id: string | null;
  meta_json: string | null;
  created_at: string;
}

export function normalizeKpiName(name: string): string {
  return name.trim().toLowerCase();
}

export function getKpi(db: Database, name: string): KpiRow | null {
  return (
    db.query<KpiRow, [string]>("SELECT * FROM kpis WHERE name = ?").get(normalizeKpiName(name)) ??
    null
  );
}

export function listKpis(db: Database): KpiRow[] {
  return db.query<KpiRow, []>("SELECT * FROM kpis ORDER BY name").all();
}

export function insertKpi(
  db: Database,
  opts: {
    name: string;
    direction: KpiDirection;
    unit?: string | null;
    note?: string | null;
    createdAt?: string;
  },
): KpiRow {
  const name = normalizeKpiName(opts.name);
  const createdAt = opts.createdAt ?? new Date().toISOString();
  db.run("INSERT INTO kpis (name, unit, direction, note, created_at) VALUES (?, ?, ?, ?, ?)", [
    name,
    opts.unit ?? null,
    opts.direction,
    opts.note ?? null,
    createdAt,
  ]);
  return {
    name,
    unit: opts.unit ?? null,
    direction: opts.direction,
    note: opts.note ?? null,
    created_at: createdAt,
  };
}

export function insertKpiGoal(
  db: Database,
  opts: { kpiName: string; target: number; setAt?: string },
): KpiGoalRow {
  const row: KpiGoalRow = {
    id: ulid(),
    kpi_name: normalizeKpiName(opts.kpiName),
    target: opts.target,
    set_at: opts.setAt ?? new Date().toISOString(),
  };
  db.run("INSERT INTO kpi_goals (id, kpi_name, target, set_at) VALUES (?, ?, ?, ?)", [
    row.id,
    row.kpi_name,
    row.target,
    row.set_at,
  ]);
  return row;
}

export function getCurrentKpiGoal(db: Database, kpiName: string): KpiGoalRow | null {
  return (
    db
      .query<KpiGoalRow, [string]>("SELECT * FROM current_kpi_goals WHERE kpi_name = ?")
      .get(normalizeKpiName(kpiName)) ?? null
  );
}

export function insertKpiReading(
  db: Database,
  opts: {
    kpiName: string;
    value: number;
    narrativeId?: string | null;
    gitHead?: string | null;
    loreCommitId?: string | null;
    meta?: Record<string, unknown> | null;
    createdAt?: string;
  },
): KpiReadingRow {
  const row: KpiReadingRow = {
    id: ulid(),
    kpi_name: normalizeKpiName(opts.kpiName),
    value: opts.value,
    narrative_id: opts.narrativeId ?? null,
    git_head: opts.gitHead ?? null,
    lore_commit_id: opts.loreCommitId ?? null,
    meta_json: opts.meta && Object.keys(opts.meta).length > 0 ? JSON.stringify(opts.meta) : null,
    created_at: opts.createdAt ?? new Date().toISOString(),
  };
  db.run(
    `INSERT INTO kpi_readings (id, kpi_name, value, narrative_id, git_head, lore_commit_id, meta_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.kpi_name,
      row.value,
      row.narrative_id,
      row.git_head,
      row.lore_commit_id,
      row.meta_json,
      row.created_at,
    ],
  );
  return row;
}

/** Newest first. */
export function listKpiReadings(db: Database, kpiName: string, limit = 50): KpiReadingRow[] {
  return db
    .query<KpiReadingRow, [string, number]>(
      "SELECT * FROM kpi_readings WHERE kpi_name = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
    )
    .all(normalizeKpiName(kpiName), limit);
}

export function getKpiReadingsForNarrative(db: Database, narrativeId: string): KpiReadingRow[] {
  return db
    .query<KpiReadingRow, [string]>(
      "SELECT * FROM kpi_readings WHERE narrative_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(narrativeId);
}
