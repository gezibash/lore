import { Database } from "bun:sqlite";
import { randomUUID } from "crypto";
import { platform } from "process";
import { resolve } from "path";
import type { LoreJob, LoreJobDetail, LoreJobStatus, LoreJobType } from "./daemon-protocol.ts";

interface JobRow extends LoreJob {
  payload_json: string;
  result_json: string | null;
}

function nowIso(now?: string): string {
  return now ?? new Date().toISOString();
}

function normalizeCodePath(codePath: string): string {
  return resolve(codePath);
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

function toJob(row: JobRow): LoreJob {
  return {
    id: row.id,
    code_path: row.code_path,
    type: row.type,
    subject: row.subject,
    status: row.status,
    owner: row.owner,
    attempt: row.attempt,
    lease_expires_at: row.lease_expires_at,
    last_error: row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
}

function toJobDetail(row: JobRow | null): LoreJobDetail | null {
  if (!row) return null;
  return {
    job: toJob(row),
    result: row.result_json ? JSON.parse(row.result_json) : null,
  };
}

let customSqliteSet = false;

function ensureDaemonSqlite(): void {
  if (customSqliteSet) return;
  customSqliteSet = true;
  if (platform !== "darwin") return;
  const paths = [
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ];
  for (const path of paths) {
    try {
      Database.setCustomSQLite(path);
      return;
    } catch {
      // Try next path.
    }
  }
}

export function openDaemonQueueDb(path: string): Database {
  ensureDaemonSqlite();
  const db = new Database(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS daemon_jobs (
      id TEXT PRIMARY KEY,
      code_path TEXT NOT NULL,
      type TEXT NOT NULL,
      subject TEXT,
      status TEXT NOT NULL,
      owner TEXT,
      attempt INTEGER NOT NULL DEFAULT 0,
      lease_expires_at TEXT,
      last_error TEXT,
      payload_json TEXT NOT NULL,
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    );
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daemon_jobs_code_status
      ON daemon_jobs(code_path, status, lease_expires_at, updated_at);
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_daemon_jobs_code_type_subject
      ON daemon_jobs(code_path, type, subject, status, updated_at);
  `);
  return db;
}

export function queueDaemonJob(
  db: Database,
  opts: {
    codePath: string;
    type: LoreJobType;
    subject?: string | null;
    payload: unknown;
    now?: string;
  },
): LoreJob {
  const id = randomUUID();
  const timestamp = nowIso(opts.now);
  const codePath = normalizeCodePath(opts.codePath);
  db.query(
    `INSERT INTO daemon_jobs
       (id, code_path, type, subject, status, owner, attempt, lease_expires_at,
        last_error, payload_json, result_json, created_at, updated_at, completed_at)
     VALUES (?, ?, ?, ?, 'queued', NULL, 0, NULL, NULL, ?, NULL, ?, ?, NULL)`,
  ).run(
    id,
    codePath,
    opts.type,
    opts.subject ?? null,
    JSON.stringify(opts.payload),
    timestamp,
    timestamp,
  );
  return {
    id,
    code_path: codePath,
    type: opts.type,
    subject: opts.subject ?? null,
    status: "queued",
    owner: null,
    attempt: 0,
    lease_expires_at: null,
    last_error: null,
    created_at: timestamp,
    updated_at: timestamp,
    completed_at: null,
  };
}

export function getDaemonJob(
  db: Database,
  opts: { id: string; codePath?: string },
): LoreJobDetail | null {
  const row =
    opts.codePath
      ? db
          .query<JobRow, [string, string]>(
            `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                    last_error, payload_json, result_json, created_at, updated_at, completed_at
             FROM daemon_jobs
             WHERE id = ? AND code_path = ?
             LIMIT 1`,
          )
          .get(opts.id, normalizeCodePath(opts.codePath))
      : db
          .query<JobRow, [string]>(
            `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                    last_error, payload_json, result_json, created_at, updated_at, completed_at
             FROM daemon_jobs
             WHERE id = ?
             LIMIT 1`,
          )
          .get(opts.id);
  return toJobDetail(row ?? null);
}

export function listDaemonJobs(
  db: Database,
  opts?: { codePath?: string; limit?: number; type?: LoreJobType },
): LoreJob[] {
  const limit = Math.max(1, Math.min(200, Math.floor(opts?.limit ?? 20)));
  if (opts?.codePath && opts.type) {
    return db
      .query<JobRow, [string, LoreJobType, number]>(
        `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                last_error, payload_json, result_json, created_at, updated_at, completed_at
         FROM daemon_jobs
         WHERE code_path = ? AND type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(normalizeCodePath(opts.codePath), opts.type, limit)
      .map(toJob);
  }
  if (opts?.codePath) {
    return db
      .query<JobRow, [string, number]>(
        `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                last_error, payload_json, result_json, created_at, updated_at, completed_at
         FROM daemon_jobs
         WHERE code_path = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(normalizeCodePath(opts.codePath), limit)
      .map(toJob);
  }
  if (opts?.type) {
    return db
      .query<JobRow, [LoreJobType, number]>(
        `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                last_error, payload_json, result_json, created_at, updated_at, completed_at
         FROM daemon_jobs
         WHERE type = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
      )
      .all(opts.type, limit)
      .map(toJob);
  }
  return db
    .query<JobRow, [number]>(
      `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
              last_error, payload_json, result_json, created_at, updated_at, completed_at
       FROM daemon_jobs
       ORDER BY created_at DESC, id DESC
       LIMIT ?`,
    )
    .all(limit)
    .map(toJob);
}

export function getLatestPendingDaemonJob(
  db: Database,
  opts: { codePath: string; type: LoreJobType; subject?: string | null },
): LoreJob | null {
  const row = db
    .query<JobRow, [string, LoreJobType, string | null]>(
      `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
              last_error, payload_json, result_json, created_at, updated_at, completed_at
       FROM daemon_jobs
       WHERE code_path = ?
         AND type = ?
         AND subject IS ?
         AND status IN ('queued', 'leased')
       ORDER BY updated_at DESC, id DESC
       LIMIT 1`,
    )
    .get(normalizeCodePath(opts.codePath), opts.type, opts.subject ?? null);
  return row ? toJob(row) : null;
}

export function claimDaemonJob(
  db: Database,
  opts: {
    codePath: string;
    owner: string;
    leaseTtlMs?: number;
    maxRetries?: number;
    type?: LoreJobType;
    id?: string;
    now?: string;
  },
): LoreJobDetail | null {
  const tx = db.transaction(
    (
      codePath: string,
      owner: string,
      leaseTtlMs: number,
      maxRetries: number | undefined,
      type: LoreJobType | null,
      id: string | null,
      timestamp: string,
    ) => {
      const ttlMs = normalizeLeaseTtlMs(leaseTtlMs);
      const expiresAt = new Date(new Date(timestamp).getTime() + ttlMs).toISOString();
      const attemptsLimit = maxAttempts(maxRetries);

      const candidate = id
        ? db
            .query<JobRow, [string, string, string, number]>(
              `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                      last_error, payload_json, result_json, created_at, updated_at, completed_at
               FROM daemon_jobs
               WHERE code_path = ?
                 AND id = ?
                 AND (
                   status = 'queued'
                   OR (status = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?)
                 )
                 AND attempt < ?
               LIMIT 1`,
            )
            .get(codePath, id, timestamp, attemptsLimit)
        : type
          ? db
              .query<JobRow, [string, LoreJobType, string, number]>(
                `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                        last_error, payload_json, result_json, created_at, updated_at, completed_at
                 FROM daemon_jobs
                 WHERE code_path = ?
                   AND type = ?
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
              .get(codePath, type, timestamp, attemptsLimit)
          : db
              .query<JobRow, [string, string, number]>(
                `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                        last_error, payload_json, result_json, created_at, updated_at, completed_at
                 FROM daemon_jobs
                 WHERE code_path = ?
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
              .get(codePath, timestamp, attemptsLimit);

      if (!candidate) return null;

      db.query(
        `UPDATE daemon_jobs
         SET status = 'leased',
             owner = ?,
             attempt = attempt + 1,
             lease_expires_at = ?,
             last_error = NULL,
             updated_at = ?
         WHERE id = ?`,
      ).run(owner, expiresAt, timestamp, candidate.id);

      return toJobDetail({
        ...candidate,
        status: "leased",
        owner,
        attempt: candidate.attempt + 1,
        lease_expires_at: expiresAt,
        last_error: null,
        updated_at: timestamp,
      });
    },
  );

  return tx(
    normalizeCodePath(opts.codePath),
    opts.owner,
    opts.leaseTtlMs ?? 30_000,
    opts.maxRetries,
    opts.type ?? null,
    opts.id ?? null,
    nowIso(opts.now),
  );
}

export function completeDaemonJob(
  db: Database,
  opts: { id: string; owner?: string; result: unknown; now?: string },
): boolean {
  const timestamp = nowIso(opts.now);
  const result = db
    .query(
      `UPDATE daemon_jobs
       SET status = 'done',
           owner = COALESCE(?, owner),
           lease_expires_at = NULL,
           last_error = NULL,
           result_json = ?,
           updated_at = ?,
           completed_at = ?
       WHERE id = ?`,
    )
    .run(opts.owner ?? null, JSON.stringify(opts.result), timestamp, timestamp, opts.id);
  return Number(result.changes ?? 0) > 0;
}

export function failDaemonJob(
  db: Database,
  opts: {
    id: string;
    owner?: string;
    error: string;
    retry?: boolean;
    maxRetries?: number;
    result?: unknown;
    now?: string;
  },
): { status: LoreJobStatus | null; requeued: boolean } {
  const tx = db.transaction(
    (
      id: string,
      owner: string | null,
      error: string,
      retry: boolean,
      maxRetries: number | undefined,
      resultJson: string | null,
      timestamp: string,
    ) => {
      const current = getDaemonJob(db, { id });
      if (!current) return { status: null, requeued: false };
      const canRetry = current.job.attempt < maxAttempts(maxRetries);
      const requeue = retry && canRetry;
      const nextStatus: LoreJobStatus = requeue ? "queued" : "failed";
      db.query(
        `UPDATE daemon_jobs
         SET status = ?,
             owner = COALESCE(?, owner),
             lease_expires_at = NULL,
             last_error = ?,
             result_json = COALESCE(?, result_json),
             updated_at = ?,
             completed_at = CASE WHEN ? = 'failed' THEN ? ELSE completed_at END
         WHERE id = ?`,
      ).run(nextStatus, owner, error, resultJson, timestamp, nextStatus, timestamp, id);
      return { status: nextStatus, requeued: requeue };
    },
  );

  return tx(
    opts.id,
    opts.owner ?? null,
    opts.error,
    opts.retry ?? false,
    opts.maxRetries,
    opts.result ? JSON.stringify(opts.result) : null,
    nowIso(opts.now),
  );
}

export function getDaemonJobCounts(
  db: Database,
  opts?: { codePath?: string },
): Record<LoreJobStatus, number> {
  const rows = opts?.codePath
    ? db
        .query<{ status: LoreJobStatus; count: number }, [string]>(
          `SELECT status, COUNT(*) as count
           FROM daemon_jobs
           WHERE code_path = ?
           GROUP BY status`,
        )
        .all(normalizeCodePath(opts.codePath))
    : db
        .query<{ status: LoreJobStatus; count: number }, []>(
          `SELECT status, COUNT(*) as count
           FROM daemon_jobs
           GROUP BY status`,
        )
        .all();
  const counts: Record<LoreJobStatus, number> = {
    queued: 0,
    leased: 0,
    done: 0,
    failed: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }
  return counts;
}

export function listActiveJobCodePaths(db: Database): string[] {
  return db
    .query<{ code_path: string }, []>(
      `SELECT DISTINCT code_path
       FROM daemon_jobs
       WHERE status IN ('queued', 'leased')
       ORDER BY code_path ASC`,
    )
    .all()
    .map((row) => row.code_path);
}

export function getRawDaemonJob(
  db: Database,
  opts: { id: string },
): JobRow | null {
  return (
    db
      .query<JobRow, [string]>(
        `SELECT id, code_path, type, subject, status, owner, attempt, lease_expires_at,
                last_error, payload_json, result_json, created_at, updated_at, completed_at
         FROM daemon_jobs
         WHERE id = ?
         LIMIT 1`,
      )
      .get(opts.id) ?? null
  );
}
