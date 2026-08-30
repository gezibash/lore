import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { createTestDb } from "../../test/support/db.ts";
import { getDatabaseSpace, vacuumDb, reclaimFreeSpace } from "./connection.ts";
import { runMigrations } from "./migrations.ts";
import { deleteOrphanedChunkRows } from "./chunks.ts";

/** Write `count` chunk+embedding pairs of 12 KB each. */
function fill(db: Database, count: number): void {
  const blob = new Uint8Array(3072 * 4);
  const chunk = db.prepare(
    `INSERT INTO chunks (id, file_path, fl_type, source_file_path, created_at)
     VALUES (?, ?, 'source', 'src/a.ts', '2024-01-01T00:00:00.000Z')`,
  );
  const embedding = db.prepare(
    `INSERT INTO embeddings (id, chunk_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, 'test-model', '2024-01-01T00:00:00.000Z')`,
  );
  db.transaction(() => {
    for (let i = 0; i < count; i++) {
      chunk.run(`c-${i}`, `./c-${i}.md`);
      embedding.run(`e-${i}`, `c-${i}`, blob);
    }
  })();
}

test("getDatabaseSpace reports the free pages a delete leaves behind", () => {
  const db = createTestDb();
  fill(db, 400);

  expect(getDatabaseSpace(db).free_bytes).toBe(0);

  db.run("DELETE FROM embeddings");
  const after = getDatabaseSpace(db);

  expect(after.free_bytes).toBeGreaterThan(0);
  expect(after.free_ratio).toBeGreaterThan(0);

  db.close();
});

test("vacuumDb shrinks the file and reports what it reclaimed", () => {
  const db = createTestDb();
  fill(db, 400);
  db.run("DELETE FROM embeddings");

  const result = vacuumDb(db);

  expect(result.file_bytes_after).toBeLessThan(result.file_bytes_before);
  expect(result.reclaimed_bytes).toBe(result.file_bytes_before - result.file_bytes_after);
  expect(getDatabaseSpace(db).free_bytes).toBe(0);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM chunks").get()?.c).toBe(400);

  db.close();
});

/** Size of a file, or 0 when it does not exist. */
function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

test("vacuumDb returns the space to the filesystem, not to the WAL", () => {
  const db = createTestDb();
  fill(db, 2400);
  db.run("DELETE FROM embeddings");

  const before = fileBytes(db.filename);
  const result = vacuumDb(db);

  // The database is in WAL mode. A VACUUM writes the new file into the WAL, so
  // without the checkpoint that follows it the file on disk keeps its old size
  // and the WAL holds a second copy. Both must be small here.
  expect(fileBytes(db.filename)).toBe(result.file_bytes_after);
  expect(fileBytes(db.filename)).toBeLessThan(before);
  expect(fileBytes(`${db.filename}-wal`)).toBe(0);

  db.close();
});

test("reclaimFreeSpace leaves a small database alone", () => {
  const db = createTestDb();
  fill(db, 100);
  db.run("DELETE FROM embeddings");

  // 100 rows free about 1 MB, well under the threshold that pays for a rewrite.
  expect(getDatabaseSpace(db).free_bytes).toBeGreaterThan(0);
  expect(reclaimFreeSpace(db)).toBeNull();

  db.close();
});

test("reclaimFreeSpace shrinks a database that is mostly free pages", () => {
  const db = createTestDb();
  fill(db, 2400);
  db.run("DELETE FROM embeddings");

  const result = reclaimFreeSpace(db);

  expect(result).not.toBeNull();
  expect(result?.reclaimed_bytes).toBeGreaterThan(16 * 1024 * 1024);
  expect(getDatabaseSpace(db).free_bytes).toBe(0);

  db.close();
});

test("the orphan purge frees pages that the next open reclaims", () => {
  const db = createTestDb();

  // Put the database in the state an older lore left it in: an embedding for
  // every chunk that has since gone. The delete paths keep this from happening
  // now; a mind written before they did still carries the rows.
  const blob = new Uint8Array(3072 * 4);
  const insert = db.prepare(
    `INSERT INTO embeddings (id, chunk_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, 'test-model', '2024-01-01T00:00:00.000Z')`,
  );
  db.transaction(() => {
    for (let i = 0; i < 2400; i++) insert.run(`e-${i}`, `chunk-gone-${i}`, blob);
  })();

  const before = getDatabaseSpace(db).file_bytes;

  // What `lore sys prune` removes, then what Engine.dbFor does on the next open.
  const purged = deleteOrphanedChunkRows(db);
  const applied = runMigrations(db);
  const result = reclaimFreeSpace(db);

  expect(purged.embeddings).toBe(2400);
  expect(applied).toBe(0);
  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM embeddings").get()?.c).toBe(0);
  expect(result).not.toBeNull();
  expect(getDatabaseSpace(db).file_bytes).toBeLessThan(before);

  db.close();
});

test("reclaimFreeSpace restores the busy timeout it lowered", () => {
  const db = createTestDb();
  fill(db, 400);
  db.run("DELETE FROM embeddings");

  reclaimFreeSpace(db);

  expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(5000);

  db.close();
});
