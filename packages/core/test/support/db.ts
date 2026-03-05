import { rmSync } from "fs";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Database } from "bun:sqlite";
import { runMigrations } from "@/db/migrations.ts";
import { openDb } from "@/db/connection.ts";

export function createTestDb(): Database {
  const db = openDb(":memory:");
  runMigrations(db);
  return db;
}

export function createTempDir(prefix = "lore-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
