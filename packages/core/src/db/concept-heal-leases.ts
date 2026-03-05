import type { Database } from "bun:sqlite";
import type { ConceptHealLeaseRow } from "@/types/index.ts";

export interface ConceptHealLeaseStatusCounts {
  queued: number;
  leased: number;
  done: number;
  failed: number;
  skipped: number;
  total: number;
}

function normalizeRetries(maxRetries: number | undefined): number {
  if (!Number.isFinite(maxRetries)) return 0;
  return Math.max(0, Math.floor(maxRetries ?? 0));
}

function maxAttempts(maxRetries: number | undefined): number {
  return normalizeRetries(maxRetries) + 1;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function normalizeLeaseTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30_000;
  return Math.max(1_000, Math.floor(value ?? 30_000));
}

export function queueConceptHealLeases(
  db: Database,
  opts: {
    lorePath: string;
    runId: string;
    conceptIds: string[];
    now?: string;
  },
): number {
  const timestamp = nowIso(opts.now);
  const seen = new Set<string>();
  let inserted = 0;

  const insert = db.query(
    `INSERT OR IGNORE INTO concept_heal_leases
       (lore_path, run_id, concept_id, status, owner, attempt, lease_expires_at, last_error, created_at, updated_at)
       VALUES (?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, ?)`,
  );

  for (const conceptId of opts.conceptIds) {
    const concept = conceptId.trim();
    if (!concept || seen.has(concept)) continue;
    seen.add(concept);
    const result = insert.run(opts.lorePath, opts.runId, concept, timestamp, timestamp);
    inserted += Number(result.changes ?? 0);
  }

  return inserted;
}

export function getConceptHealLease(
  db: Database,
  opts: { lorePath: string; runId: string; conceptId: string },
): ConceptHealLeaseRow | null {
  return (
    db
      .query<ConceptHealLeaseRow, [string, string, string]>(
        `SELECT lore_path, run_id, concept_id, status, owner, attempt, lease_expires_at, last_error, created_at, updated_at
         FROM concept_heal_leases
         WHERE lore_path = ? AND run_id = ? AND concept_id = ?
         LIMIT 1`,
      )
      .get(opts.lorePath, opts.runId, opts.conceptId) ?? null
  );
}

export function listConceptHealLeasesForRun(
  db: Database,
  opts: { lorePath: string; runId: string },
): ConceptHealLeaseRow[] {
  return db
    .query<ConceptHealLeaseRow, [string, string]>(
      `SELECT lore_path, run_id, concept_id, status, owner, attempt, lease_expires_at, last_error, created_at, updated_at
       FROM concept_heal_leases
       WHERE lore_path = ? AND run_id = ?
       ORDER BY updated_at ASC, concept_id ASC`,
    )
    .all(opts.lorePath, opts.runId);
}

export function claimConceptHealLease(
  db: Database,
  opts: {
    lorePath: string;
    runId: string;
    owner: string;
    leaseTtlMs?: number;
    maxRetries?: number;
    now?: string;
  },
): ConceptHealLeaseRow | null {
  const lease = db.transaction(
    (
      lorePath: string,
      runId: string,
      owner: string,
      leaseTtlMs: number,
      maxRetries: number | undefined,
      timestamp: string,
    ) => {
      const ttlMs = normalizeLeaseTtlMs(leaseTtlMs);
      const expiresAt = new Date(new Date(timestamp).getTime() + ttlMs).toISOString();
      const attemptsLimit = maxAttempts(maxRetries);

      const candidate = db
        .query<ConceptHealLeaseRow, [string, string, string, number]>(
          `SELECT lore_path, run_id, concept_id, status, owner, attempt, lease_expires_at, last_error, created_at, updated_at
           FROM concept_heal_leases
           WHERE lore_path = ?
             AND run_id = ?
             AND (
               status = 'queued'
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
             AND attempt < ?
           ORDER BY
             CASE status WHEN 'queued' THEN 0 ELSE 1 END,
             attempt ASC,
             updated_at ASC,
             concept_id ASC
           LIMIT 1`,
        )
        .get(lorePath, runId, timestamp, attemptsLimit);

      if (!candidate) return null;

      db.query(
        `UPDATE concept_heal_leases
         SET status = 'leased',
             owner = ?,
             attempt = attempt + 1,
             lease_expires_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE lore_path = ? AND run_id = ? AND concept_id = ?`,
      ).run(owner, expiresAt, timestamp, lorePath, runId, candidate.concept_id);

      return {
        ...candidate,
        status: "leased",
        owner,
        attempt: candidate.attempt + 1,
        lease_expires_at: expiresAt,
        last_error: null,
        updated_at: timestamp,
      } satisfies ConceptHealLeaseRow;
    },
  );

  return lease(
    opts.lorePath,
    opts.runId,
    opts.owner,
    opts.leaseTtlMs ?? 30_000,
    opts.maxRetries,
    nowIso(opts.now),
  );
}

export function completeConceptHealLease(
  db: Database,
  opts: {
    lorePath: string;
    runId: string;
    conceptId: string;
    owner?: string;
    now?: string;
  },
): boolean {
  const timestamp = nowIso(opts.now);
  const result = db
    .query(
      `UPDATE concept_heal_leases
       SET status = 'done',
           owner = COALESCE(?, owner),
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = ?
       WHERE lore_path = ? AND run_id = ? AND concept_id = ?`,
    )
    .run(opts.owner ?? null, timestamp, opts.lorePath, opts.runId, opts.conceptId);

  return Number(result.changes ?? 0) > 0;
}

export function skipConceptHealLease(
  db: Database,
  opts: {
    lorePath: string;
    runId: string;
    conceptId: string;
    owner?: string;
    reason?: string;
    now?: string;
  },
): boolean {
  const timestamp = nowIso(opts.now);
  const result = db
    .query(
      `UPDATE concept_heal_leases
       SET status = 'skipped',
           owner = COALESCE(?, owner),
           lease_expires_at = NULL,
           last_error = ?,
           updated_at = ?
       WHERE lore_path = ? AND run_id = ? AND concept_id = ?`,
    )
    .run(
      opts.owner ?? null,
      opts.reason ?? null,
      timestamp,
      opts.lorePath,
      opts.runId,
      opts.conceptId,
    );

  return Number(result.changes ?? 0) > 0;
}

export function failConceptHealLease(
  db: Database,
  opts: {
    lorePath: string;
    runId: string;
    conceptId: string;
    owner?: string;
    error: string;
    retry?: boolean;
    maxRetries?: number;
    now?: string;
  },
): { status: ConceptHealLeaseRow["status"] | null; requeued: boolean } {
  const tx = db.transaction(
    (
      lorePath: string,
      runId: string,
      conceptId: string,
      owner: string | null,
      error: string,
      retry: boolean,
      maxRetries: number | undefined,
      timestamp: string,
    ) => {
      const current = getConceptHealLease(db, { lorePath, runId, conceptId });
      if (!current) return { status: null, requeued: false };

      const canRetry = current.attempt < maxAttempts(maxRetries);
      const requeue = retry && canRetry;
      const nextStatus = requeue ? "queued" : "failed";

      db.query(
        `UPDATE concept_heal_leases
         SET status = ?,
             owner = ?,
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?
         WHERE lore_path = ? AND run_id = ? AND concept_id = ?`,
      ).run(
        nextStatus,
        requeue ? null : (owner ?? current.owner),
        error,
        timestamp,
        lorePath,
        runId,
        conceptId,
      );

      return {
        status: nextStatus,
        requeued: requeue,
      } satisfies { status: ConceptHealLeaseRow["status"]; requeued: boolean };
    },
  );

  return tx(
    opts.lorePath,
    opts.runId,
    opts.conceptId,
    opts.owner ?? null,
    opts.error,
    opts.retry ?? true,
    opts.maxRetries,
    nowIso(opts.now),
  );
}

export function getConceptHealLeaseStatusCounts(
  db: Database,
  opts: { lorePath: string; runId: string },
): ConceptHealLeaseStatusCounts {
  const row = db
    .query<
      {
        queued: number;
        leased: number;
        done: number;
        failed: number;
        skipped: number;
        total: number;
      },
      [string, string]
    >(
      `SELECT
         SUM(CASE WHEN status = 'queued' THEN 1 ELSE 0 END) AS queued,
         SUM(CASE WHEN status = 'leased' THEN 1 ELSE 0 END) AS leased,
         SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS done,
         SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
         SUM(CASE WHEN status = 'skipped' THEN 1 ELSE 0 END) AS skipped,
         COUNT(*) AS total
       FROM concept_heal_leases
       WHERE lore_path = ? AND run_id = ?`,
    )
    .get(opts.lorePath, opts.runId);

  return {
    queued: Number(row?.queued ?? 0),
    leased: Number(row?.leased ?? 0),
    done: Number(row?.done ?? 0),
    failed: Number(row?.failed ?? 0),
    skipped: Number(row?.skipped ?? 0),
    total: Number(row?.total ?? 0),
  };
}
