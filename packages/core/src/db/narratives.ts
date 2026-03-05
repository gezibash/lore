import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { NarrativeRow, NarrativeTarget } from "@/types/index.ts";

/** Insert a narrative with caller-supplied id and fields (used by rebuild). */
export function insertNarrativeRaw(
  db: Database,
  id: string,
  name: string,
  opts: {
    intent: string;
    status: string;
    entryCount: number;
    openedAt: string;
    closedAt?: string | null;
    theta?: number | null;
    convergence?: number | null;
    magnitude?: number | null;
  },
): void {
  const versionId = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO narratives (version_id, id, name, intent, status, entry_count, theta, convergence, magnitude, opened_at, closed_at, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionId,
      id,
      name,
      opts.intent,
      opts.status,
      opts.entryCount,
      opts.theta ?? null,
      opts.convergence ?? null,
      opts.magnitude ?? null,
      opts.openedAt,
      opts.closedAt ?? null,
      now,
    ],
  );
}

export function insertNarrative(
  db: Database,
  name: string,
  intent: string,
  mergeBaseCommitId: string | null = null,
  targets?: NarrativeTarget[],
): NarrativeRow {
  const id = ulid();
  const versionId = ulid();
  const now = new Date().toISOString();
  const targetsJson = targets && targets.length > 0 ? JSON.stringify(targets) : null;
  db.run(
    `INSERT INTO narratives (version_id, id, name, intent, status, entry_count, merge_base_commit_id, targets, opened_at, inserted_at)
     VALUES (?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)`,
    [versionId, id, name, intent, mergeBaseCommitId, targetsJson, now, now],
  );
  return {
    version_id: versionId,
    id,
    name,
    intent,
    status: "open",
    theta: null,
    magnitude: null,
    convergence: null,
    entry_count: 0,
    merge_base_commit_id: mergeBaseCommitId,
    targets: targetsJson,
    opened_at: now,
    closed_at: null,
    inserted_at: now,
  };
}

/** Insert a new version of an existing narrative with updated fields (append-only). */
function insertNarrativeVersion(
  db: Database,
  current: NarrativeRow,
  fields: Partial<
    Pick<
      NarrativeRow,
      | "status"
      | "theta"
      | "magnitude"
      | "convergence"
      | "entry_count"
      | "merge_base_commit_id"
      | "closed_at"
    >
  >,
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO narratives (version_id, id, name, intent, status, theta, magnitude, convergence, entry_count, merge_base_commit_id, targets, opened_at, closed_at, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      current.id,
      current.name,
      current.intent,
      fields.status ?? current.status,
      fields.theta !== undefined ? fields.theta : current.theta,
      fields.magnitude !== undefined ? fields.magnitude : current.magnitude,
      fields.convergence !== undefined ? fields.convergence : current.convergence,
      fields.entry_count ?? current.entry_count,
      fields.merge_base_commit_id !== undefined
        ? fields.merge_base_commit_id
        : current.merge_base_commit_id,
      current.targets,
      current.opened_at,
      fields.closed_at !== undefined ? fields.closed_at : current.closed_at,
      now,
    ],
  );
}

export function getNarrative(db: Database, id: string): NarrativeRow | null {
  return db.query<NarrativeRow, [string]>("SELECT * FROM current_narratives WHERE id = ?").get(id) ?? null;
}

export function getOpenNarrativeByName(db: Database, name: string): NarrativeRow | null {
  return (
    db
      .query<NarrativeRow, [string]>("SELECT * FROM current_narratives WHERE name = ? AND status = 'open'")
      .get(name) ?? null
  );
}

export function getNarrativeByName(db: Database, name: string): NarrativeRow | null {
  return (
    db.query<NarrativeRow, [string]>("SELECT * FROM current_narratives WHERE name = ?").get(name) ?? null
  );
}

export function getOpenNarratives(db: Database): NarrativeRow[] {
  return db
    .query<NarrativeRow, []>("SELECT * FROM current_narratives WHERE status = 'open' ORDER BY opened_at")
    .all();
}

export function closeNarrative(db: Database, id: string): void {
  const current = getNarrative(db, id);
  if (!current) return;
  insertNarrativeVersion(db, current, {
    status: "closed",
    closed_at: new Date().toISOString(),
  });
}

export function abandonNarrative(db: Database, id: string): void {
  const current = getNarrative(db, id);
  if (!current) return;
  insertNarrativeVersion(db, current, {
    status: "abandoned",
    closed_at: new Date().toISOString(),
  });
}

export function updateNarrativeMetrics(
  db: Database,
  id: string,
  fields: Partial<Pick<NarrativeRow, "theta" | "magnitude" | "convergence" | "entry_count">>,
): void {
  const current = getNarrative(db, id);
  if (!current) return;
  insertNarrativeVersion(db, current, fields);
}

export function getDanglingNarratives(db: Database, danglingDays: number): NarrativeRow[] {
  const cutoff = new Date(Date.now() - danglingDays * 24 * 60 * 60 * 1000).toISOString();
  return db
    .query<NarrativeRow, [string]>(
      `SELECT * FROM current_narratives
       WHERE status = 'open' AND opened_at < ?
       ORDER BY opened_at`,
    )
    .all(cutoff);
}

export function getMergeBaseCommitId(db: Database, narrativeId: string): string | null {
  const narrative = getNarrative(db, narrativeId);
  return narrative?.merge_base_commit_id ?? null;
}

export function getAllNarratives(db: Database): NarrativeRow[] {
  return db.query<NarrativeRow, []>("SELECT * FROM current_narratives ORDER BY opened_at DESC").all();
}
