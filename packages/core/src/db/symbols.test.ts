import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertSymbol,
  deleteSymbolsForSourceFile,
  countOrphanedSymbolRows,
  deleteOrphanedSymbolRows,
  sumOrphanedSymbolRows,
} from "./symbols.ts";
import { upsertSourceFile } from "./source-files.ts";
import { insertSymbolEmbedding } from "./embeddings.ts";

function addFile(db: Database, filePath: string): string {
  return upsertSourceFile(db, {
    filePath,
    language: "typescript",
    contentHash: `hash-${filePath}`,
    sizeBytes: 100,
    symbolCount: 0,
  }).id;
}

function addSymbol(db: Database, sourceFileId: string, name: string): string {
  const id = insertSymbol(db, {
    sourceFileId,
    name,
    qualifiedName: name,
    kind: "function",
    parentId: null,
    lineStart: 1,
    lineEnd: 5,
    signature: null,
    bodyHash: `body-${name}`,
    exportStatus: "exported",
  }).id;
  db.run(
    `INSERT INTO symbol_fts (name, qualified_name, signature, symbol_id, source_file_path)
     VALUES (?, ?, '', ?, 'src/a.ts')`,
    [name, name, id],
  );
  insertSymbolEmbedding(db, id, new Float32Array([0.1, 0.2, 0.3]), "code-model");
  return id;
}

function countRows(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

test("deleteSymbolsForSourceFile clears every dependent of the symbols it removes", () => {
  const db = createTestDb();
  const fileA = addFile(db, "src/a.ts");
  const fileB = addFile(db, "src/b.ts");
  addSymbol(db, fileA, "one");
  addSymbol(db, fileA, "two");
  const kept = addSymbol(db, fileB, "three");

  expect(countRows(db, "symbol_embeddings")).toBe(3);

  deleteSymbolsForSourceFile(db, fileA);

  expect(countRows(db, "symbols")).toBe(1);
  expect(countRows(db, "symbol_embeddings")).toBe(1);
  expect(countRows(db, "symbol_fts")).toBe(1);
  expect(
    db.query<{ symbol_id: string }, []>("SELECT symbol_id FROM symbol_embeddings").get()?.symbol_id,
  ).toBe(kept);
  expect(countOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 0, symbol_fts: 0 });

  db.close();
});

test("re-scanning a changed file leaves no orphan symbol rows", () => {
  const db = createTestDb();
  const fileId = addFile(db, "src/changed.ts");
  addSymbol(db, fileId, "alpha");
  addSymbol(db, fileId, "beta");

  // A scan mints a fresh id for every symbol, so the re-inserted rows never
  // overwrite what the previous version left.
  deleteSymbolsForSourceFile(db, fileId);
  addSymbol(db, fileId, "alpha");

  expect(countOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 0, symbol_fts: 0 });
  expect(countRows(db, "symbol_embeddings")).toBe(1);

  db.close();
});

test("deleteOrphanedSymbolRows clears rows a past symbol delete left behind", () => {
  const db = createTestDb();
  const fileId = addFile(db, "src/a.ts");
  const live = addSymbol(db, fileId, "live");

  // What an older lore left: the symbol gone, its rows still there.
  const dead = addSymbol(db, fileId, "dead");
  db.run(`DELETE FROM symbols WHERE id = ?`, [dead]);

  const found = countOrphanedSymbolRows(db);
  expect(found).toEqual({ symbol_embeddings: 1, symbol_fts: 1 });
  expect(sumOrphanedSymbolRows(found)).toBe(2);

  expect(deleteOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 1, symbol_fts: 1 });

  expect(countOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 0, symbol_fts: 0 });
  expect(
    db.query<{ symbol_id: string }, []>("SELECT symbol_id FROM symbol_embeddings").get()?.symbol_id,
  ).toBe(live);

  db.close();
});

test("a NULL symbol id does not stop the sweep", () => {
  const db = createTestDb();
  const fileId = addFile(db, "src/a.ts");
  addSymbol(db, fileId, "live");
  const dead = addSymbol(db, fileId, "dead");
  db.run(`DELETE FROM symbols WHERE id = ?`, [dead]);

  // SQLite lets a TEXT PRIMARY KEY hold NULL. Under NOT IN, one such row makes
  // the whole sweep match nothing.
  db.run(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, scanned_at)
     VALUES (NULL, ?, 'null-id', 'null-id', 'function', 1, 2, '2024-01-01T00:00:00.000Z')`,
    [fileId],
  );

  expect(deleteOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 1, symbol_fts: 1 });
  expect(countOrphanedSymbolRows(db)).toEqual({ symbol_embeddings: 0, symbol_fts: 0 });

  db.close();
});
