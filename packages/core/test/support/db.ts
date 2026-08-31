import { rmSync } from "fs";
import { mkdtempSync, writeFileSync } from "fs";
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

/**
 * A lore root whose config points embedding at the stub server.
 *
 * Use this for any engine test. The default config points embedding at
 * Ollama on localhost, which makes the test depend on what the machine
 * runs. See test/support/stub-embedder.ts.
 */
export function createTestLoreRoot(prefix = "lore-root-"): string {
  const dir = createTempDir(prefix);
  const baseUrl = process.env.LORE_TEST_EMBED_URL;
  if (!baseUrl) {
    throw new Error(
      "LORE_TEST_EMBED_URL is unset — preload test/support/stub-embedder.ts",
    );
  }
  writeFileSync(
    join(dir, "config.json"),
    JSON.stringify({ ai: { embedding: { provider: "ollama", base_url: baseUrl } } }),
  );
  return dir;
}

export function removeDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}
