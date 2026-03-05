import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";
import { platform } from "node:process";

let customSqliteSet = false;

export function ensureCustomSqlite(): void {
  if (customSqliteSet) return;
  customSqliteSet = true;

  // macOS uses Apple's system SQLite which has extension loading disabled.
  // Swap in Homebrew's SQLite before any Database instantiation.
  if (platform === "darwin") {
    const paths = [
      "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
      "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
    ];
    for (const p of paths) {
      try {
        Database.setCustomSQLite(p);
        return;
      } catch {
        // Try next path
      }
    }
    console.warn("Warning: Could not find Homebrew SQLite. Install with: brew install sqlite");
  }
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
  sqliteVec.load(db);
  return db;
}
