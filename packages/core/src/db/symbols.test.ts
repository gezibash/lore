import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import { insertSymbol, deleteSymbolsForSourceFile } from "./symbols.ts";
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
  return insertSymbol(db, {
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
}

function countSymbolEmbeddings(db: Database): number {
  return (
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM symbol_embeddings").get()
      ?.count ?? 0
  );
}

function countOrphans(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM symbol_embeddings se
         LEFT JOIN symbols s ON s.id = se.symbol_id
         WHERE s.id IS NULL`,
      )
      .get()?.count ?? 0
  );
}

test("deleteSymbolsForSourceFile removes the embeddings of the deleted symbols", () => {
  const db = createTestDb();
  const fileA = addFile(db, "src/a.ts");
  const fileB = addFile(db, "src/b.ts");

  for (const name of ["one", "two"]) {
    insertSymbolEmbedding(db, addSymbol(db, fileA, name), new Float32Array([0.1, 0.2]), "code");
  }
  const keptId = addSymbol(db, fileB, "three");
  insertSymbolEmbedding(db, keptId, new Float32Array([0.3, 0.4]), "code");

  expect(countSymbolEmbeddings(db)).toBe(3);

  deleteSymbolsForSourceFile(db, fileA);

  expect(countSymbolEmbeddings(db)).toBe(1);
  expect(
    db.query<{ symbol_id: string }, []>("SELECT symbol_id FROM symbol_embeddings").get()?.symbol_id,
  ).toBe(keptId);

  db.close();
});

test("re-scanning a changed file leaves no orphan symbol embeddings", () => {
  const db = createTestDb();
  const fileId = addFile(db, "src/changed.ts");

  // First scan.
  for (const name of ["alpha", "beta"]) {
    insertSymbolEmbedding(db, addSymbol(db, fileId, name), new Float32Array([0.1, 0.2]), "code");
  }

  // Second scan: the scanner deletes the symbols, then re-inserts them. Every
  // symbol gets a fresh id, so nothing overwrites the old embeddings.
  deleteSymbolsForSourceFile(db, fileId);
  insertSymbolEmbedding(db, addSymbol(db, fileId, "alpha"), new Float32Array([0.5, 0.6]), "code");

  expect(countOrphans(db)).toBe(0);
  expect(countSymbolEmbeddings(db)).toBe(1);

  db.close();
});
