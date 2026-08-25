import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { platform } from "node:process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

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
  db.exec("PRAGMA busy_timeout = 5000");
  loadVectorExtension(db);
  return db;
}
