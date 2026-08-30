import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";
import { getMigrationStatus, listMigrationNames, readMigrationSql } from "./migrator.ts";

test("migrate applies pending migrations once", () => {
  const db = new Database(":memory:");

  const first = runMigrations(db);
  const second = runMigrations(db);
  const status = getMigrationStatus(db);

  expect(first).toBeGreaterThan(0);
  expect(second).toBe(0);
  expect(status.pending).toEqual([]);
  expect(status.applied.length).toBeGreaterThan(0);

  db.close();
});

test("getMigrationStatus does not auto-stamp 001_initial from existing schema", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE manifest (version_id TEXT PRIMARY KEY)");

  const status = getMigrationStatus(db);
  expect(status.applied).toEqual([]);
  expect(status.pending).toEqual(listMigrationNames());

  db.close();
});

test("030 removes embeddings whose chunk is gone and keeps the rest", () => {
  const db = new Database(":memory:");
  runMigrations(db);

  db.run(
    `INSERT INTO chunks (id, file_path, fl_type, created_at) VALUES ('live', './live.md', 'source', '2024-01-01T00:00:00.000Z')`,
  );
  for (const [id, chunkId] of [
    ["e-live", "live"],
    ["e-orphan", "gone"],
  ] as const) {
    db.run(
      `INSERT INTO embeddings (id, chunk_id, embedding, model, embedded_at)
       VALUES (?, ?, x'00', 'test-model', '2024-01-01T00:00:00.000Z')`,
      [id, chunkId],
    );
  }

  db.exec(readMigrationSql("030_orphan_embeddings"));

  const rows = db.query<{ id: string }, []>("SELECT id FROM embeddings ORDER BY id").all();
  expect(rows.map((r) => r.id)).toEqual(["e-live"]);

  db.close();
});

test("031 removes symbol embeddings whose symbol is gone and keeps the rest", () => {
  const db = new Database(":memory:");
  runMigrations(db);

  db.run(
    `INSERT INTO source_files (id, file_path, language, content_hash, size_bytes, symbol_count, scanned_at)
     VALUES ('f1', 'src/a.ts', 'typescript', 'h', 100, 1, '2024-01-01T00:00:00.000Z')`,
  );
  db.run(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, scanned_at)
     VALUES ('live', 'f1', 'one', 'one', 'function', 1, 5, '2024-01-01T00:00:00.000Z')`,
  );
  for (const [id, symbolId] of [
    ["se-live", "live"],
    ["se-orphan", "gone"],
  ] as const) {
    db.run(
      `INSERT INTO symbol_embeddings (id, symbol_id, embedding, model, embedded_at)
       VALUES (?, ?, x'00', 'code-model', '2024-01-01T00:00:00.000Z')`,
      [id, symbolId],
    );
  }

  db.exec(readMigrationSql("031_orphan_symbol_embeddings"));

  const rows = db.query<{ id: string }, []>("SELECT id FROM symbol_embeddings ORDER BY id").all();
  expect(rows.map((r) => r.id)).toEqual(["se-live"]);

  db.close();
});
