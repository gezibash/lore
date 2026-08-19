import { rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Database } from "bun:sqlite";
import { runMigrations } from "@/db/migrations.ts";
import { openDb } from "@/db/connection.ts";

export function createTestDb(): Database {
  // File-backed (not :memory:) so the Lance-derived search index — which lives
  // alongside the SQLite file — is exercised for real in tests.
  const dir = mkdtempSync(join(tmpdir(), "lore-testdb-"));
  const db = openDb(join(dir, "lore.db"));
  runMigrations(db);
  return db;
}

export function createTempDir(prefix = "lore-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
