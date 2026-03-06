import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { CloseJobRow } from "@/types/index.ts";

export interface CloseJobCounts {
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

export function queueCloseJob(
  db: Database,
  opts: {
    lorePath: string;
    narrativeId: string;
    narrativeName: string;
    payload: unknown;
    now?: string;
  },
): { id: string; created_at: string } {
  const id = ulid();
  const timestamp = nowIso(opts.now);
  db.query(
    `INSERT INTO close_jobs
       (id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
        last_error, payload_json, close_result_json, created_at, updated_at, completed_at)
       VALUES (?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, NULL, ?, ?, NULL)`,
  ).run(
    id,
    opts.lorePath,
    opts.narrativeId,
    opts.narrativeName,
    JSON.stringify(opts.payload),
    timestamp,
    timestamp,
  );
  return { id, created_at: timestamp };
}

export function getCloseJob(
  db: Database,
  opts: { lorePath: string; id: string },
): CloseJobRow | null {
  return (
    db
      .query<CloseJobRow, [string, string]>(
        `SELECT id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
                last_error, payload_json, close_result_json, created_at, updated_at, completed_at
         FROM close_jobs
         WHERE lore_path = ? AND id = ?
         LIMIT 1`,
      )
      .get(opts.lorePath, opts.id) ?? null
  );
}

export function getLatestPendingCloseJobForNarrative(
  db: Database,
  opts: { lorePath: string; narrativeId: string },
): CloseJobRow | null {
  return (
    db
      .query<CloseJobRow, [string, string]>(
        `SELECT id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
                last_error, payload_json, close_result_json, created_at, updated_at, completed_at
         FROM close_jobs
         WHERE lore_path = ?
           AND narrative_id = ?
           AND status IN ('queued', 'leased')
         ORDER BY updated_at DESC, id DESC
         LIMIT 1`,
      )
      .get(opts.lorePath, opts.narrativeId) ?? null
  );
}

export function listCloseJobs(
  db: Database,
  opts: { lorePath: string; limit?: number },
): CloseJobRow[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts.limit ?? 20)));
  return db
    .query<CloseJobRow, [string, number]>(
      `SELECT id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
              last_error, payload_json, close_result_json, created_at, updated_at, completed_at
       FROM close_jobs
       WHERE lore_path = ?
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(opts.lorePath, limit);
}

export function claimCloseJob(
  db: Database,
  opts: {
    lorePath: string;
    owner: string;
    leaseTtlMs?: number;
    maxRetries?: number;
    id?: string;
    now?: string;
  },
): CloseJobRow | null {
  const lease = db.transaction(
    (
      lorePath: string,
      owner: string,
      leaseTtlMs: number,
      maxRetries: number | undefined,
      id: string | null,
      timestamp: string,
    ) => {
      const ttlMs = normalizeLeaseTtlMs(leaseTtlMs);
      const expiresAt = new Date(new Date(timestamp).getTime() + ttlMs).toISOString();
      const attemptsLimit = maxAttempts(maxRetries);
      const candidate = id
        ? db
            .query<CloseJobRow, [string, string, string, number]>(
              `SELECT id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
                      last_error, payload_json, close_result_json, created_at, updated_at, completed_at
               FROM close_jobs
               WHERE lore_path = ?
                 AND id = ?
                 AND (
                   status = 'queued'
                   OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
                 )
                 AND attempt < ?
               LIMIT 1`,
            )
            .get(lorePath, id, timestamp, attemptsLimit)
        : db
            .query<CloseJobRow, [string, string, number]>(
              `SELECT id, lore_path, narrative_id, narrative_name, status, owner, attempt, lease_expires_at,
                      last_error, payload_json, close_result_json, created_at, updated_at, completed_at
               FROM close_jobs
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
        `UPDATE close_jobs
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
      } satisfies CloseJobRow;
    },
  );

  return lease(
    opts.lorePath,
    opts.owner,
    opts.leaseTtlMs ?? 30_000,
    opts.maxRetries,
    opts.id ?? null,
    nowIso(opts.now),
  );
}

export function completeCloseJob(
  db: Database,
  opts: { lorePath: string; id: string; owner?: string; result: unknown; now?: string },
): boolean {
  const timestamp = nowIso(opts.now);
  const update = db
    .query(
      `UPDATE close_jobs
       SET status = 'done',
           owner = COALESCE(?, owner),
           lease_expires_at = NULL,
           last_error = NULL,
           close_result_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE lore_path = ? AND id = ?`,
    )
    .run(
      opts.owner ?? null,
      JSON.stringify(opts.result),
      timestamp,
      timestamp,
      opts.lorePath,
      opts.id,
    );
  return Number(update.changes ?? 0) > 0;
}

export function failCloseJob(
  db: Database,
  opts: {
    lorePath: string;
    id: string;
    owner?: string;
    error: string;
    retry?: boolean;
    maxRetries?: number;
    result?: unknown;
    now?: string;
  },
): { status: CloseJobRow["status"] | null; requeued: boolean } {
  const tx = db.transaction(
    (
      lorePath: string,
      id: string,
      owner: string | null,
      error: string,
      retry: boolean,
      maxRetries: number | undefined,
      resultJson: string | null,
      timestamp: string,
    ) => {
      const current = getCloseJob(db, { lorePath, id });
      if (!current) return { status: null, requeued: false };

      const canRetry = current.attempt < maxAttempts(maxRetries);
      const requeue = retry && canRetry;
      const nextStatus: CloseJobRow["status"] = requeue ? "queued" : "failed";

      db.query(
        `UPDATE close_jobs
         SET status = ?,
             owner = COALESCE(?, owner),
             lease_expires_at = NULL,
             last_error = ?,
             close_result_json = COALESCE(?, close_result_json),
             updated_at = ?,
             completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
         WHERE lore_path = ? AND id = ?`,
      ).run(nextStatus, owner, error, resultJson, timestamp, nextStatus, timestamp, lorePath, id);

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
    opts.result !== undefined ? JSON.stringify(opts.result) : null,
    nowIso(opts.now),
  );
}

export function getCloseJobCounts(db: Database, opts: { lorePath: string }): CloseJobCounts {
  const rows = db
    .query<{ status: CloseJobRow["status"]; count: number }, [string]>(
      `SELECT status, COUNT(*) as count
       FROM close_jobs
       WHERE lore_path = ?
       GROUP BY status`,
    )
    .all(opts.lorePath);

  const counts: CloseJobCounts = {
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
       FROM close_jobs
       WHERE lore_path = ?
         AND status IN ('queued', 'leased')
       ORDER BY created_at ASC
       LIMIT 1`,
    )
    .get(opts.lorePath);
  counts.oldest_pending_at = oldestPending?.created_at ?? null;
  return counts;
}

export function hasPendingCloseJobs(db: Database, opts: { lorePath: string }): boolean {
  const row = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count
       FROM close_jobs
       WHERE lore_path = ?
         AND status IN ('queued', 'leased')`,
    )
    .get(opts.lorePath);
  return (row?.count ?? 0) > 0;
}
