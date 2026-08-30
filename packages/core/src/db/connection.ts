import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { platform } from "node:process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

const BUSY_TIMEOUT_MS = 5000;

let customSqliteSet = false;

/** A native library shipped beside a compiled binary, in `lib/` next to it.
 *  A compiled binary cannot resolve these through node_modules — the package
 *  directory sqlite-vec looks in does not exist inside the bundle — so the
 *  build script copies them out and they are found by path instead. */
function sidecarLib(name: string): string | null {
  const candidate = join(dirname(process.execPath), "lib", name);
  return existsSync(candidate) ? candidate : null;
}

export function ensureCustomSqlite(): void {
  if (customSqliteSet) return;
  customSqliteSet = true;
  if (platform !== "darwin") return;

  // Apple's system SQLite is built without extension loading, so sqlite-vec
  // cannot load into it. Prefer the copy shipped with the binary; fall back to
  // Homebrew's for a source checkout.
  const paths = [
    sidecarLib("libsqlite3.dylib"),
    "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
    "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
  ].filter((path): path is string => path !== null);

  for (const path of paths) {
    try {
      Database.setCustomSQLite(path);
      return;
    } catch {
      // Try next path
    }
  }
  console.warn("Warning: Could not find a SQLite with extension loading enabled.");
}

/** Load sqlite-vec, preferring the copy shipped beside a compiled binary. */
function loadVectorExtension(db: Database): void {
  const sidecar = sidecarLib(platform === "darwin" ? "vec0.dylib" : "vec0.so");
  if (sidecar) {
    db.loadExtension(sidecar);
    return;
  }
  sqliteVec.load(db);
}

/**
 * Open a per-project database. Caller manages lifecycle (closing).
 * Sets WAL mode, busy_timeout, and loads sqlite-vec.
 */
export function openDb(dbPath: string): Database {
  ensureCustomSqlite();
  const db = new Database(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  loadVectorExtension(db);
  return db;
}

// ─── Space reclamation ───────────────────────────────────

/** Page accounting for the database file. SQLite reuses free pages for later
 *  inserts but never returns them to the filesystem, so a file that once held
 *  many rows keeps its size after they are deleted. VACUUM is the only way to
 *  shrink it. */
export interface DatabaseSpace {
  file_bytes: number;
  free_bytes: number;
  free_ratio: number;
}

export interface VacuumResult {
  file_bytes_before: number;
  file_bytes_after: number;
  reclaimed_bytes: number;
}

// A VACUUM rewrites the whole file, so it must return enough to pay for the
// work. Under these limits the free pages are cheaper to leave in place: the
// next inserts use them and the file does not grow.
const RECLAIM_MIN_FREE_BYTES = 16 * 1024 * 1024;
const RECLAIM_MIN_FREE_RATIO = 0.1;

export function getDatabaseSpace(db: Database): DatabaseSpace {
  const pageSize = db.query<{ page_size: number }, []>("PRAGMA page_size").get()?.page_size ?? 0;
  const pageCount =
    db.query<{ page_count: number }, []>("PRAGMA page_count").get()?.page_count ?? 0;
  const freeCount =
    db.query<{ freelist_count: number }, []>("PRAGMA freelist_count").get()?.freelist_count ?? 0;

  return {
    file_bytes: pageCount * pageSize,
    free_bytes: freeCount * pageSize,
    free_ratio: pageCount > 0 ? freeCount / pageCount : 0,
  };
}

/** Rewrite the database file without its free pages. The caller must hold no
 *  open transaction, because SQLite refuses a VACUUM inside one. */
export function vacuumDb(db: Database): VacuumResult {
  const before = getDatabaseSpace(db).file_bytes;
  db.exec("VACUUM");
  const after = getDatabaseSpace(db).file_bytes;
  return {
    file_bytes_before: before,
    file_bytes_after: after,
    reclaimed_bytes: Math.max(0, before - after),
  };
}

/** Shrink the file when a large part of it is free. Deletes leave free pages
 *  behind: a removed source file, a changed source file whose chunks are
 *  rewritten under new ids, an embeddings refresh, a rebuild. Returns null when
 *  the file is not worth the work, or when another connection holds the
 *  database and the VACUUM cannot start. */
export function reclaimFreeSpace(db: Database): VacuumResult | null {
  const space = getDatabaseSpace(db);
  if (space.free_bytes < RECLAIM_MIN_FREE_BYTES) return null;
  if (space.free_ratio < RECLAIM_MIN_FREE_RATIO) return null;

  // busy_timeout is 5 seconds, and this runs on the path that opens a database
  // for a command. A contended VACUUM must fail at once instead of stalling
  // that command, so drop the wait for the length of the attempt.
  db.exec("PRAGMA busy_timeout = 0");
  try {
    return vacuumDb(db);
  } catch {
    // VACUUM needs the whole database to itself. Another process is using it,
    // so leave the pages where they are; the next open tries again.
    return null;
  } finally {
    db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  }
}
