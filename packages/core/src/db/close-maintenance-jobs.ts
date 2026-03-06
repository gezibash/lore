import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { CloseMaintenanceJobRow } from "@/types/index.ts";

export interface CloseMaintenanceJobCounts {
  queued: number;
  leased: number;
  failed: number;
  done: number;
  total: number;
  oldest_pending_at: string | null;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function normalizeLeaseTtlMs(value: number | undefined): number {
  if (!Number.isFinite(value)) return 30_000;
  return Math.max(1_000, Math.floor(value ?? 30_000));
}

function normalizeRetries(maxRetries: number | undefined): number {
  if (!Number.isFinite(maxRetries)) return 0;
  return Math.max(0, Math.floor(maxRetries ?? 0));
}

function maxAttempts(maxRetries: number | undefined): number {
  return normalizeRetries(maxRetries) + 1;
}

export function queueCloseMaintenanceJob(
  db: Database,
  opts: {
    lorePath: string;
    narrativeId: string;
    narrativeName: string;
    commitId: string;
    payload: unknown;
    now?: string;
  },
): { id: string; created_at: string } {
  const id = ulid();
  const timestamp = nowIso(opts.now);
  db.query(
    `INSERT INTO close_maintenance_jobs
       (id, lore_path, narrative_id, narrative_name, commit_id, status, owner, attempt, lease_expires_at, last_error, payload_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, ?, ?, NULL)`,
  ).run(
    id,
    opts.lorePath,
    opts.narrativeId,
    opts.narrativeName,
    opts.commitId,
    JSON.stringify(opts.payload),
    timestamp,
    timestamp,
  );
  return { id, created_at: timestamp };
}

export function getCloseMaintenanceJob(
  db: Database,
  opts: { lorePath: string; id: string },
): CloseMaintenanceJobRow | null {
  return (
    db
      .query<CloseMaintenanceJobRow, [string, string]>(
        `SELECT id, lore_path, narrative_id, narrative_name, commit_id, status, owner, attempt, lease_expires_at,
                last_error, payload_json, created_at, updated_at, completed_at
         FROM close_maintenance_jobs
         WHERE lore_path = ? AND id = ?
         LIMIT 1`,
      )
      .get(opts.lorePath, opts.id) ?? null
  );
}

export function claimCloseMaintenanceJob(
  db: Database,
  opts: {
    lorePath: string;
    owner: string;
    leaseTtlMs?: number;
    maxRetries?: number;
    now?: string;
  },
): CloseMaintenanceJobRow | null {
  const lease = db.transaction(
    (
      lorePath: string,
      owner: string,
      leaseTtlMs: number,
      maxRetries: number | undefined,
      timestamp: string,
    ) => {
      const ttlMs = normalizeLeaseTtlMs(leaseTtlMs);
      const expiresAt = new Date(new Date(timestamp).getTime() + ttlMs).toISOString();
      const attemptsLimit = maxAttempts(maxRetries);

      const candidate = db
        .query<CloseMaintenanceJobRow, [string, string, number]>(
          `SELECT id, lore_path, narrative_id, narrative_name, commit_id, status, owner, attempt, lease_expires_at,
                  last_error, payload_json, created_at, updated_at, completed_at
           FROM close_maintenance_jobs
           WHERE lore_path = ?
             AND (
               status = 'queued'
               OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
             )
             AND attempt < ?
           ORDER BY
             CASE status WHEN 'queued' THEN 0 ELSE 1 END,
             updated_at ASC,
             id ASC
           LIMIT 1`,
        )
        .get(lorePath, timestamp, attemptsLimit);

      if (!candidate) return null;

      db.query(
        `UPDATE close_maintenance_jobs
         SET status = 'leased',
             owner = ?,
             attempt = attempt + 1,
             lease_expires_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE lore_path = ? AND id = ?`,
      ).run(owner, expiresAt, timestamp, lorePath, candidate.id);

      return {
        ...candidate,
        status: "leased",
        owner,
        attempt: candidate.attempt + 1,
        lease_expires_at: expiresAt,
        last_error: null,
        updated_at: timestamp,
      } satisfies CloseMaintenanceJobRow;
    },
  );

  return lease(
    opts.lorePath,
    opts.owner,
    opts.leaseTtlMs ?? 30_000,
    opts.maxRetries,
    nowIso(opts.now),
  );
}

export function completeCloseMaintenanceJob(
  db: Database,
  opts: { lorePath: string; id: string; owner?: string; now?: string },
): boolean {
  const timestamp = nowIso(opts.now);
  const result = db
    .query(
      `UPDATE close_maintenance_jobs
       SET status = 'done',
           owner = COALESCE(?, owner),
           lease_expires_at = NULL,
           last_error = NULL,
           updated_at = ?,
           completed_at = ?
       WHERE lore_path = ? AND id = ?`,
    )
    .run(opts.owner ?? null, timestamp, timestamp, opts.lorePath, opts.id);
  return Number(result.changes ?? 0) > 0;
}

export function failCloseMaintenanceJob(
  db: Database,
  opts: {
    lorePath: string;
    id: string;
    owner?: string;
    error: string;
    retry?: boolean;
    maxRetries?: number;
    now?: string;
  },
): { status: CloseMaintenanceJobRow["status"] | null; requeued: boolean } {
  const tx = db.transaction(
    (
      lorePath: string,
      id: string,
      owner: string | null,
      error: string,
      retry: boolean,
      maxRetries: number | undefined,
      timestamp: string,
    ) => {
      const current = getCloseMaintenanceJob(db, { lorePath, id });
      if (!current) return { status: null, requeued: false };

      const canRetry = current.attempt < maxAttempts(maxRetries);
      const requeue = retry && canRetry;
      const nextStatus: CloseMaintenanceJobRow["status"] = requeue ? "queued" : "failed";

      db.query(
        `UPDATE close_maintenance_jobs
         SET status = ?,
             owner = COALESCE(?, owner),
             lease_expires_at = NULL,
             last_error = ?,
             updated_at = ?,
             completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
         WHERE lore_path = ? AND id = ?`,
      ).run(nextStatus, owner, error, timestamp, nextStatus, timestamp, lorePath, id);

      return { status: nextStatus, requeued: requeue };
    },
  );

  return tx(
    opts.lorePath,
    opts.id,
    opts.owner ?? null,
    opts.error,
    opts.retry ?? false,
    opts.maxRetries,
    nowIso(opts.now),
  );
}

export function getCloseMaintenanceJobCounts(
  db: Database,
  opts: { lorePath: string },
): CloseMaintenanceJobCounts {
  const rows = db
    .query<{ status: CloseMaintenanceJobRow["status"]; count: number }, [string]>(
      `SELECT status, COUNT(*) as count
       FROM close_maintenance_jobs
       WHERE lore_path = ?
       GROUP BY status`,
    )
    .all(opts.lorePath);
  const counts: CloseMaintenanceJobCounts = {
    queued: 0,
    leased: 0,
    failed: 0,
    done: 0,
    total: 0,
    oldest_pending_at: null,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
    counts.total += row.count;
  }
  const oldestPending = db
    .query<{ created_at: string }, [string]>(
      `SELECT created_at
       FROM close_maintenance_jobs
       WHERE lore_path = ?
         AND status IN ('queued', 'leased')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(opts.lorePath);
  counts.oldest_pending_at = oldestPending?.created_at ?? null;
  return counts;
}

export function hasPendingCloseMaintenanceJobs(db: Database, opts: { lorePath: string }): boolean {
  const row = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count
       FROM close_maintenance_jobs
       WHERE lore_path = ?
         AND status IN ('queued', 'leased')`,
    )
    .get(opts.lorePath);
  return (row?.count ?? 0) > 0;
}
