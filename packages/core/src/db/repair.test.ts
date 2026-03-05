import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
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
