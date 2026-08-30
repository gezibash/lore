import { test, expect } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { openDb } from "./connection.ts";
import { auditSchema, repairSchema } from "./repair.ts";
import { listMigrationNames } from "./migrator.ts";

test("auditSchema reports missing chunk_refs table", () => {
  const db = createTestDb();
  db.exec("DROP TABLE chunk_refs");

  const issues = auditSchema(db);
  expect(issues.some((i) => i.kind === "missing_table" && i.name === "chunk_refs")).toBe(true);

  db.close();
});

test("repairSchema check mode reports issues without mutating", () => {
  const db = createTestDb();
  db.exec("DROP TABLE chunk_refs");

  const check = repairSchema(db, { check: true });
  expect(check.mode).toBe("check");
  expect(check.ok).toBe(false);
  expect(check.fixed).toHaveLength(0);
  expect(check.remaining.some((i) => i.kind === "missing_table" && i.name === "chunk_refs")).toBe(
    true,
  );

  const chunkRefs = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_refs'",
    )
    .get();
  expect(chunkRefs).toBeNull();

  db.close();
});

test("repairSchema recreates missing schema objects", () => {
  const db = createTestDb();
  db.exec("DROP TABLE chunk_refs");

  const result = repairSchema(db);
  expect(result.mode).toBe("apply");
  expect(result.ok).toBe(true);
  expect(result.fixed.some((i) => i.kind === "missing_table" && i.name === "chunk_refs")).toBe(
    true,
  );

  const chunkRefs = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_refs'",
    )
    .get();
  expect(chunkRefs?.name).toBe("chunk_refs");

  const idx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunk_refs_chunk'",
    )
    .get();
  expect(idx?.name).toBe("idx_chunk_refs_chunk");

  const hashIdx = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_chunk_refs_content_hash'",
    )
    .get();
  expect(hashIdx?.name).toBe("idx_chunk_refs_content_hash");

  db.close();
});

test("repairSchema reconciles missing migration ledger rows when schema is current", () => {
  const db = createTestDb();
  db.exec("DELETE FROM _migrations");

  const result = repairSchema(db);
  expect(result.ok).toBe(true);
  expect(result.migrations_reconciled).toBeGreaterThan(0);

  const row = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM _migrations").get();
  expect(row?.count).toBe(listMigrationNames().length);

  db.close();
});

/** A migrations directory that repair cannot stamp on DDL equivalence alone.
 *  `001_initial` is in the reconcilable set, so repair stamps it. The second
 *  migration is not in that set, so repair must run it instead. */
function writeFixtureMigrations(sql: string): string {
  const dir = createTempDir("lore-migrations-");
  writeFileSync(
    join(dir, "001_initial.sql"),
    "CREATE TABLE parts (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n",
  );
  writeFileSync(join(dir, "900_backfill_state.sql"), sql);
  return dir;
}

function openFixtureDb(): { db: Database; dir: string } {
  const dir = createTempDir();
  const db = openDb(join(dir, "lore.db"));
  db.exec("CREATE TABLE parts (id TEXT PRIMARY KEY, state TEXT NOT NULL)");
  db.exec("INSERT INTO parts (id, state) VALUES ('a', 'new')");
  return { db, dir };
}

test("repairSchema runs a pending migration it refuses to stamp", () => {
  const migrationsDir = writeFixtureMigrations(
    "UPDATE parts SET state = 'ready' WHERE state = 'new';\n",
  );
  const { db, dir } = openFixtureDb();

  const result = repairSchema(db, { migrationsDir });

  expect(result.ok).toBe(true);
  // 001_initial is stamped; the unlisted migration is run, not stamped blind.
  expect(result.migrations_reconciled).toBe(1);
  expect(result.migrations_applied).toBe(1);
  expect(result.fixed.some((i) => i.kind === "pending_migration" && i.name === "001_initial")).toBe(
    true,
  );

  const row = db.query<{ state: string }, []>("SELECT state FROM parts WHERE id = 'a'").get();
  expect(row?.state).toBe("ready");

  const names = db
    .query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name")
    .all()
    .map((r) => r.name);
  expect(names).toEqual(["001_initial", "900_backfill_state"]);

  db.close();
  removeDir(dir);
  removeDir(migrationsDir);
});

test("repairSchema reports a migration error instead of claiming success", () => {
  const migrationsDir = writeFixtureMigrations(
    "UPDATE parts SET state = 'ready' WHERE state = 'new';\n",
  );
  const { db, dir } = openFixtureDb();
  // A ledger row whose file is gone, which an older binary leaves behind. The
  // migrator refuses to run against it, so repair must report that failure.
  db.exec(
    "CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
  );
  db.exec("INSERT INTO _migrations (name, applied_at) VALUES ('999_gone', '2026-01-01T00:00:00Z')");

  const result = repairSchema(db, { migrationsDir });

  expect(result.ok).toBe(false);
  expect(result.migrations_reconciled).toBe(1);
  expect(result.migrations_applied).toBe(0);
  expect(
    result.remaining.some((i) => i.kind === "migration_error" && i.name === "migrate:reconcile"),
  ).toBe(true);
  expect(
    result.remaining.some((i) => i.kind === "pending_migration" && i.name === "900_backfill_state"),
  ).toBe(true);

  db.close();
  removeDir(dir);
  removeDir(migrationsDir);
});
