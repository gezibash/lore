import type { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";

const MIGRATIONS_DIR = join(import.meta.dirname, "migrations");

export interface MigrationStatus {
  applied: { name: string; applied_at: string }[];
  pending: string[];
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

export function listMigrationNames(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => f.replace(/\.sql$/, ""));
}

export function readMigrationSql(name: string): string {
  return readFileSync(join(MIGRATIONS_DIR, `${name}.sql`), "utf-8");
}

export function getMigrationStatus(db: Database): MigrationStatus {
  ensureMigrationsTable(db);

  const applied = db
    .query<{ name: string; applied_at: string }, []>(
      "SELECT name, applied_at FROM _migrations ORDER BY name",
    )
    .all();

  const appliedSet = new Set(applied.map((r) => r.name));
  const diskNames = listMigrationNames();

  // Integrity check: every applied migration must still exist on disk
  for (const row of applied) {
    if (!diskNames.includes(row.name)) {
      throw new Error(
        `Migration '${row.name}' was previously applied but its file is missing from disk`,
      );
    }
  }

  const pending = diskNames.filter((name) => !appliedSet.has(name));

  return { applied, pending };
}

export function migrate(db: Database): number {
  const { pending } = getMigrationStatus(db);

  let count = 0;
  for (const name of pending) {
    const sql = readMigrationSql(name);

    db.transaction(() => {
      db.exec(sql);
      db.exec(
        `INSERT INTO _migrations (name, applied_at) VALUES ('${name}', '${new Date().toISOString()}')`,
      );
    })();
    count++;
  }

  return count;
}
