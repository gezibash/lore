import type { Database } from "bun:sqlite";
import { existsSync, readFileSync, readdirSync } from "fs";
import { dirname, join } from "path";

/** Migrations are .sql data files, so a compiled binary cannot carry them in
 *  its bundle. The build script copies the directory next to the executable;
 *  a source checkout finds it beside this module. Discovery stays by
 *  directory listing either way, so adding a migration is still just adding
 *  a file. */
function resolveMigrationsDir(): string {
  const bundled = join(import.meta.dirname, "migrations");
  if (existsSync(bundled)) return bundled;
  return join(dirname(process.execPath), "migrations");
}

/** The installed migrations directory. Every function below takes it as a
 *  parameter that defaults to this path. A caller passes a different directory
 *  to read a different set of migrations. A test uses this to present a
 *  migration that the installed set does not have. */
const MIGRATIONS_DIR = resolveMigrationsDir();

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

export function listMigrationNames(migrationsDir: string = MIGRATIONS_DIR): string[] {
  return readdirSync(migrationsDir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((f) => f.replace(/\.sql$/, ""));
}

export function readMigrationSql(name: string, migrationsDir: string = MIGRATIONS_DIR): string {
  return readFileSync(join(migrationsDir, `${name}.sql`), "utf-8");
}

export function getMigrationStatus(db: Database, migrationsDir?: string): MigrationStatus {
  ensureMigrationsTable(db);

  const applied = db
    .query<{ name: string; applied_at: string }, []>(
      "SELECT name, applied_at FROM _migrations ORDER BY name",
    )
    .all();

  const appliedSet = new Set(applied.map((r) => r.name));
  const diskNames = listMigrationNames(migrationsDir);

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

/** Split a migration file into single statements.
 *
 *  `db.exec` discards a run-time error when another statement follows the one
 *  that failed, and every migration file ends with a newline. A failed data
 *  statement therefore raised nothing and the migration still stamped as
 *  applied. One statement per call makes every error reach the caller.
 *
 *  The scan tracks string literals, quoted identifiers, and comments, so a
 *  semicolon inside one does not split the file. A CREATE TRIGGER body holds
 *  its own semicolons, so the body ends at the END that closes it. A CASE
 *  expression inside the body also ends with END, so those are counted and
 *  do not close the body early. */
export function splitSqlStatements(sql: string): string[] {
  const statements: string[] = [];
  let start = 0;
  let i = 0;
  let firstWord = "";
  let isTrigger = false;
  let bodyOpen = false;
  let caseDepth = 0;
  let sawContent = false;

  function endStatement(end: number): void {
    if (sawContent) statements.push(sql.slice(start, end).trim());
    start = end;
    firstWord = "";
    isTrigger = false;
    bodyOpen = false;
    caseDepth = 0;
    sawContent = false;
  }

  while (i < sql.length) {
    const ch = sql[i]!;

    if (ch === "-" && sql[i + 1] === "-") {
      const newline = sql.indexOf("\n", i);
      i = newline === -1 ? sql.length : newline + 1;
      continue;
    }
    if (ch === "/" && sql[i + 1] === "*") {
      const close = sql.indexOf("*/", i + 2);
      i = close === -1 ? sql.length : close + 2;
      continue;
    }
    if (ch === ";") {
      i++;
      if (!bodyOpen) endStatement(i);
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }

    sawContent = true;

    // A quoted string or identifier. A doubled quote inside one is an escape.
    if (ch === "'" || ch === '"' || ch === "`") {
      i++;
      while (i < sql.length) {
        if (sql[i] !== ch) {
          i++;
          continue;
        }
        if (sql[i + 1] === ch) {
          i += 2;
          continue;
        }
        i++;
        break;
      }
      continue;
    }
    if (ch === "[") {
      const close = sql.indexOf("]", i + 1);
      i = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = i;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end]!)) end++;
      const word = sql.slice(i, end).toUpperCase();
      i = end;

      if (firstWord === "") firstWord = word;
      if (word === "TRIGGER" && firstWord === "CREATE") isTrigger = true;
      else if (isTrigger && !bodyOpen && word === "BEGIN") bodyOpen = true;
      else if (bodyOpen && word === "CASE") caseDepth++;
      else if (bodyOpen && word === "END") {
        if (caseDepth > 0) caseDepth--;
        else bodyOpen = false;
      }
      continue;
    }

    i++;
  }

  endStatement(sql.length);
  return statements;
}

export function migrate(db: Database, migrationsDir?: string): number {
  const { pending } = getMigrationStatus(db, migrationsDir);

  let count = 0;
  for (const name of pending) {
    const statements = splitSqlStatements(readMigrationSql(name, migrationsDir));

    db.transaction(() => {
      for (const statement of statements) {
        db.run(statement);
      }
      db.run(
        `INSERT INTO _migrations (name, applied_at) VALUES ('${name}', '${new Date().toISOString()}')`,
      );
    })();
    count++;
  }

  return count;
}
