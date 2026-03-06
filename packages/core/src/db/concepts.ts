import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ConceptLifecycleStatus, ConceptRow } from "@/types/index.ts";

export interface InsertConceptRawOpts {
  id: string;
  name: string;
  opts?: {
    activeChunkId?: string | null;
    residual?: number | null;
    staleness?: number | null;
    cluster?: number | null;
    lifecycleStatus?: ConceptLifecycleStatus;
    archivedAt?: string | null;
    lifecycleReason?: string | null;
    mergedIntoConceptId?: string | null;
  };
}

export type ConceptVersionFields = Partial<
  Pick<
    ConceptRow,
    | "name"
    | "active_chunk_id"
    | "residual"
    | "churn"
    | "ground_residual"
    | "lore_residual"
    | "staleness"
    | "cluster"
    | "is_hub"
    | "lifecycle_status"
    | "archived_at"
    | "lifecycle_reason"
    | "merged_into_concept_id"
  >
>;

function loadCurrentConceptsByIds(db: Database, ids: readonly string[]): Map<string, ConceptRow> {
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(", ");
  const rows = db
    .query<ConceptRow, string[]>(`SELECT * FROM current_concepts WHERE id IN (${placeholders})`)
    .all(...ids);
  return new Map(rows.map((row) => [row.id, row]));
}

/** Insert a concept with a caller-supplied id (used by rebuild). */
export function insertConceptRaw(
  db: Database,
  id: string,
  name: string,
  opts?: {
    activeChunkId?: string | null;
    residual?: number | null;
    staleness?: number | null;
    cluster?: number | null;
    lifecycleStatus?: ConceptLifecycleStatus;
    archivedAt?: string | null;
    lifecycleReason?: string | null;
    mergedIntoConceptId?: string | null;
  },
): void {
  insertConceptRawBatch(db, [{ id, name, opts }]);
}

export function insertConceptRawBatch(db: Database, items: InsertConceptRawOpts[]): void {
  if (items.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO concepts (version_id, id, name, active_chunk_id, residual, staleness, cluster, lifecycle_status, archived_at, lifecycle_reason, merged_into_concept_id, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const item of items) {
    stmt.run(
      ulid(),
      item.id,
      item.name,
      item.opts?.activeChunkId ?? null,
      item.opts?.residual ?? null,
      item.opts?.staleness ?? null,
      item.opts?.cluster ?? null,
      item.opts?.lifecycleStatus ?? "active",
      item.opts?.archivedAt ?? null,
      item.opts?.lifecycleReason ?? null,
      item.opts?.mergedIntoConceptId ?? null,
      now,
    );
  }
}

export function insertConcept(
  db: Database,
  name: string,
  opts?: { cluster?: number; activeChunkId?: string },
): ConceptRow {
  const id = ulid();
  const versionId = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO concepts (version_id, id, name, active_chunk_id, cluster, lifecycle_status, archived_at, lifecycle_reason, merged_into_concept_id, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      versionId,
      id,
      name,
      opts?.activeChunkId ?? null,
      opts?.cluster ?? null,
      "active",
      null,
      null,
      null,
      now,
    ],
  );
  return {
    version_id: versionId,
    id,
    name,
    active_chunk_id: opts?.activeChunkId ?? null,
    residual: null,
    churn: null,
    ground_residual: null,
    lore_residual: null,
    staleness: null,
    cluster: opts?.cluster ?? null,
    is_hub: null,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
    inserted_at: now,
  };
}

/** Insert a new version of an existing concept (append-only update). */
export function insertConceptVersion(db: Database, id: string, fields: ConceptVersionFields): void {
  insertConceptVersionBatch(db, [{ id, fields }]);
}

export function insertConceptVersionBatch(
  db: Database,
  items: Array<{ id: string; fields: ConceptVersionFields }>,
  currentById?: Map<string, ConceptRow>,
): void {
  if (items.length === 0) return;
  const conceptMap =
    currentById ?? loadCurrentConceptsByIds(db, [...new Set(items.map((item) => item.id))]);
  const stmt = db.prepare(
    `INSERT INTO concepts (version_id, id, name, active_chunk_id, residual, churn, ground_residual, lore_residual, staleness, cluster, is_hub, lifecycle_status, archived_at, lifecycle_reason, merged_into_concept_id, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const item of items) {
    const current = conceptMap.get(item.id);
    if (!current) continue;
    const fields = item.fields;
    stmt.run(
      ulid(),
      current.id,
      fields.name ?? current.name,
      fields.active_chunk_id !== undefined ? fields.active_chunk_id : current.active_chunk_id,
      fields.residual !== undefined ? fields.residual : current.residual,
      fields.churn !== undefined ? fields.churn : current.churn,
      fields.ground_residual !== undefined ? fields.ground_residual : current.ground_residual,
      fields.lore_residual !== undefined ? fields.lore_residual : current.lore_residual,
      fields.staleness !== undefined ? fields.staleness : current.staleness,
      fields.cluster !== undefined ? fields.cluster : current.cluster,
      fields.is_hub !== undefined ? fields.is_hub : current.is_hub,
      fields.lifecycle_status !== undefined
        ? fields.lifecycle_status
        : (current.lifecycle_status ?? "active"),
      fields.archived_at !== undefined ? fields.archived_at : current.archived_at,
      fields.lifecycle_reason !== undefined ? fields.lifecycle_reason : current.lifecycle_reason,
      fields.merged_into_concept_id !== undefined
        ? fields.merged_into_concept_id
        : current.merged_into_concept_id,
      now,
    );
  }
}

export function getConcept(db: Database, id: string): ConceptRow | null {
  return (
    db.query<ConceptRow, [string]>("SELECT * FROM current_concepts WHERE id = ?").get(id) ?? null
  );
}

export function getConceptByName(db: Database, name: string): ConceptRow | null {
  return (
    db.query<ConceptRow, [string]>("SELECT * FROM current_concepts WHERE name = ?").get(name) ??
    null
  );
}

export function getConcepts(db: Database): ConceptRow[] {
  return db.query<ConceptRow, []>("SELECT * FROM current_concepts ORDER BY name").all();
}

export function getActiveConcepts(db: Database): ConceptRow[] {
  return db
    .query<ConceptRow, []>(
      `SELECT * FROM current_concepts
       WHERE lifecycle_status IS NULL OR lifecycle_status = 'active'
       ORDER BY name`,
    )
    .all();
}

export function getConceptsByCluster(
  db: Database,
  cluster: number,
  excludeId?: string,
): ConceptRow[] {
  if (excludeId) {
    return db
      .query<ConceptRow, [number, string]>(
        `SELECT * FROM current_concepts
         WHERE (lifecycle_status IS NULL OR lifecycle_status = 'active')
           AND cluster = ?
           AND id != ?
         ORDER BY name`,
      )
      .all(cluster, excludeId);
  }
  return db
    .query<ConceptRow, [number]>(
      `SELECT * FROM current_concepts
       WHERE (lifecycle_status IS NULL OR lifecycle_status = 'active')
         AND cluster = ?
       ORDER BY name`,
    )
    .all(cluster);
}

export function getActiveConceptByName(db: Database, name: string): ConceptRow | null {
  return (
    db
      .query<ConceptRow, [string]>(
        `SELECT * FROM current_concepts
       WHERE name = ? AND (lifecycle_status IS NULL OR lifecycle_status = 'active')
       LIMIT 1`,
      )
      .get(name) ?? null
  );
}

export function getPreviousConceptMetrics(
  db: Database,
  conceptId: string,
): { residual: number | null; staleness: number | null } | null {
  return (
    db
      .query<{ residual: number | null; staleness: number | null }, [string]>(
        `SELECT residual, staleness FROM concepts
         WHERE id = ?
         ORDER BY rowid DESC
         LIMIT 1 OFFSET 1`,
      )
      .get(conceptId) ?? null
  );
}

export function getConceptsByNameCaseInsensitive(db: Database, name: string): ConceptRow[] {
  return db
    .query<ConceptRow, [string]>(
      `SELECT * FROM current_concepts
       WHERE lower(name) = lower(?)
       ORDER BY inserted_at DESC`,
    )
    .all(name);
}

export function isConceptNameTaken(
  db: Database,
  name: string,
  opts?: { excludeId?: string },
): boolean {
  const rows = getConceptsByNameCaseInsensitive(db, name);
  if (!opts?.excludeId) return rows.length > 0;
  return rows.some((r) => r.id !== opts.excludeId);
}

export function getConceptCount(db: Database): number {
  const row = db
    .query<{ count: number }, []>("SELECT COUNT(*) as count FROM current_concepts")
    .get();
  return row?.count ?? 0;
}

export function getActiveConceptCount(db: Database): number {
  const row = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM current_concepts
       WHERE lifecycle_status IS NULL OR lifecycle_status = 'active'`,
    )
    .get();
  return row?.count ?? 0;
}
