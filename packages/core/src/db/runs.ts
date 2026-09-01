import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { RunOutcome, RunRow } from "@/types/index.ts";

/** A run name is a label a person types, so it is trimmed and never empty. */
export function normalizeRunName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new Error("Run name cannot be empty");
  return name;
}

function encode(value: Record<string, unknown> | undefined | null): string | null {
  if (!value) return null;
  return Object.keys(value).length > 0 ? JSON.stringify(value) : null;
}

export function insertRun(
  db: Database,
  opts: {
    name: string;
    outcome: RunOutcome;
    params?: Record<string, string> | null;
    metrics?: Record<string, number> | null;
    artifacts?: string[] | null;
    note?: string | null;
    narrativeId?: string | null;
    gitHead?: string | null;
    loreCommitId?: string | null;
    createdAt?: string;
  },
): RunRow {
  const row: RunRow = {
    id: ulid(),
    name: normalizeRunName(opts.name),
    outcome: opts.outcome,
    params_json: encode(opts.params),
    metrics_json: encode(opts.metrics),
    artifacts_json:
      opts.artifacts && opts.artifacts.length > 0 ? JSON.stringify(opts.artifacts) : null,
    note: opts.note ?? null,
    narrative_id: opts.narrativeId ?? null,
    git_head: opts.gitHead ?? null,
    lore_commit_id: opts.loreCommitId ?? null,
    created_at: opts.createdAt ?? new Date().toISOString(),
  };
  db.run(
    `INSERT INTO runs (id, name, outcome, params_json, metrics_json, artifacts_json, note,
       narrative_id, git_head, lore_commit_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id,
      row.name,
      row.outcome,
      row.params_json,
      row.metrics_json,
      row.artifacts_json,
      row.note,
      row.narrative_id,
      row.git_head,
      row.lore_commit_id,
      row.created_at,
    ],
  );
  return row;
}

export function getRun(db: Database, id: string): RunRow | null {
  return db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id) ?? null;
}

/** Newest first. A name narrows to one series; `since` is an ISO timestamp. */
export function listRuns(
  db: Database,
  opts?: { name?: string; since?: string; limit?: number },
): RunRow[] {
  const clauses: string[] = [];
  const params: (string | number)[] = [];
  if (opts?.name) {
    clauses.push("name = ?");
    params.push(normalizeRunName(opts.name));
  }
  if (opts?.since) {
    clauses.push("created_at >= ?");
    params.push(opts.since);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  params.push(Math.max(1, opts?.limit ?? 50));
  return db
    .query<RunRow, (string | number)[]>(
      `SELECT * FROM runs ${where} ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(...params);
}

export function countRuns(db: Database): number {
  return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM runs").get()?.n ?? 0;
}
