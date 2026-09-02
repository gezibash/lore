import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertSymbol,
  deleteSymbolsForSourceFile,
  countOrphanedSymbolRows,
  deleteOrphanedSymbolRows,
  sumOrphanedSymbolRows,
  findSymbolsByName,
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

/** A method carries a qualified name its class prefixes, and a reader types
 *  the short name every listing prints. */
function addMethod(db: Database, sourceFileId: string, owner: string, name: string): string {
  return insertSymbol(db, {
    sourceFileId,
    name,
    qualifiedName: `${owner}.${name}`,
    kind: "method",
    parentId: null,
    lineStart: 12,
    lineEnd: 20,
    signature: null,
    bodyHash: `body-${owner}-${name}`,
    exportStatus: "exported",
  }).id;
}

test("findSymbolsByName returns every symbol sharing a short name", () => {
  const db = createTestDb();
  const engine = addFile(db, "src/engine.ts");
  const worker = addFile(db, "src/worker.ts");
  const first = addMethod(db, engine, "LoreEngine", "open");
  const second = addMethod(db, worker, "WorkerClient", "open");

  const found = findSymbolsByName(db, "open");

  expect(found.map((s) => s.id)).toEqual([first, second]);
  expect(found.map((s) => s.file_path)).toEqual(["src/engine.ts", "src/worker.ts"]);
  db.close();
});

test("findSymbolsByName matches a qualified name too", () => {
  const db = createTestDb();
  const engine = addFile(db, "src/engine.ts");
  const wanted = addMethod(db, engine, "LoreEngine", "open");
  addMethod(db, addFile(db, "src/worker.ts"), "WorkerClient", "open");

  const found = findSymbolsByName(db, "LoreEngine.open");

  expect(found.map((s) => s.id)).toEqual([wanted]);
  db.close();
});

test("findSymbolsByName returns both rows when a constant is declared twice", () => {
  const db = createTestDb();
  const a = addSymbol(db, addFile(db, "src/sdk.ts"), "GENERATION_PROMPT_KEYS");
  const b = addSymbol(db, addFile(db, "src/worker.ts"), "GENERATION_PROMPT_KEYS");

  expect(
    findSymbolsByName(db, "GENERATION_PROMPT_KEYS")
      .map((s) => s.id)
      .sort(),
  ).toEqual([a, b].sort());
  db.close();
});

test("findSymbolsByName finds nothing for a name no file declares", () => {
  const db = createTestDb();
  addSymbol(db, addFile(db, "src/a.ts"), "present");

  expect(findSymbolsByName(db, "absent")).toHaveLength(0);
  db.close();
});

/** A top-level `parse` and a `Lexer.parse` both answer to the short name. */
test("an exact qualified name wins alone", () => {
  const db = createTestDb();
  const top = addSymbol(db, addFile(db, "src/top.ts"), "parse");
  addMethod(db, addFile(db, "src/lexer.ts"), "Lexer", "parse");

  // The bare name reaches both, and the qualified form names one.
  expect(findSymbolsByName(db, "parse").map((s) => s.id)).toEqual([top]);
  expect(findSymbolsByName(db, "Lexer.parse")).toHaveLength(1);
  db.close();
});

test("two short-name matches with no exact qualified hit both return", () => {
  const db = createTestDb();
  addMethod(db, addFile(db, "src/a.ts"), "A", "run");
  addMethod(db, addFile(db, "src/b.ts"), "B", "run");

  expect(findSymbolsByName(db, "run")).toHaveLength(2);
  db.close();
});
