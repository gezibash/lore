import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertEmbedding,
  getEmbeddingForChunk,
  vectorSearch,
  getAllEmbeddings,
  countEmbeddingsByModel,
  countSymbolEmbeddingsByModel,
  insertSymbolEmbedding,
} from "./embeddings.ts";
import { insertConcept, insertConceptVersion } from "./concepts.ts";
import { insertChunk } from "./chunks.ts";
import { insertSymbol } from "./symbols.ts";
import { upsertSourceFile } from "./source-files.ts";

test("insertEmbedding and getEmbeddingForChunk roundtrip", () => {
  const db = createTestDb();
  const emb = insertEmbedding(
    db,
    "chunk-roundtrip",
    new Float32Array([0.1, 0.2, 0.3]),
    "test-model",
  );

  const row = getEmbeddingForChunk(db, "chunk-roundtrip");
  expect(row?.id).toBe(emb);
  expect(row?.model).toBe("test-model");
  expect(row?.embedding).toBeInstanceOf(Uint8Array);

  db.close();
});

test("vectorSearch excludes archived concept chunks", () => {
  const db = createTestDb();
  const active = insertConcept(db, "active");
  const archived = insertConcept(db, "archived");

  insertConceptVersion(db, archived.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
  });

  insertChunk(db, {
    id: "active-chunk",
    filePath: "./active.md",
    flType: "chunk",
    conceptId: active.id,
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "archived-chunk",
    filePath: "./archived.md",
    flType: "chunk",
    conceptId: archived.id,
    createdAt: new Date().toISOString(),
  });

  insertEmbedding(db, "active-chunk", new Float32Array([1, 0, 0]), "test");
  insertEmbedding(db, "archived-chunk", new Float32Array([0, 1, 0]), "test");

  const results = vectorSearch(db, new Float32Array([1, 0, 0]), "chunk", 10);
  const ids = results.map((r) => r.chunkId);
  expect(ids).toContain("active-chunk");
  expect(ids).not.toContain("archived-chunk");

  db.close();
});

test("vectorSearch filters by source type", () => {
  const db = createTestDb();
  insertChunk(db, {
    id: "state-chunk",
    filePath: "./state.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "journal-chunk",
    filePath: "./journal.md",
    flType: "journal",
    createdAt: new Date().toISOString(),
  });

  insertEmbedding(db, "state-chunk", new Float32Array([1, 0]), "test");
  insertEmbedding(db, "journal-chunk", new Float32Array([1, 0]), "test");

  expect(vectorSearch(db, new Float32Array([1, 0]), "chunk", 10).map((r) => r.chunkId)).toEqual([
    "state-chunk",
  ]);
  expect(vectorSearch(db, new Float32Array([1, 0]), "journal", 10).map((r) => r.chunkId)).toEqual([
    "journal-chunk",
  ]);
  db.close();
});

test("getAllEmbeddings excludes superseded and archived chunks", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "c1");
  insertConceptVersion(db, concept.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
  });

  insertChunk(db, {
    id: "archived-chunk",
    filePath: "./a.md",
    flType: "chunk",
    conceptId: concept.id,
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "active-chunk",
    filePath: "./b.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "superseded-chunk",
    filePath: "./c.md",
    flType: "chunk",
    supersedesId: "active-chunk",
    createdAt: new Date().toISOString(),
  });

  insertEmbedding(db, "archived-chunk", new Float32Array([1]), "test");
  insertEmbedding(db, "active-chunk", new Float32Array([1]), "test");
  insertEmbedding(db, "superseded-chunk", new Float32Array([1]), "test");

  const rows = getAllEmbeddings(db, "chunk");
  expect(rows.map((row) => row.chunk_id).sort()).toEqual(["superseded-chunk"]);

  db.close();
});

test("countEmbeddingsByModel counts the live embeddings of each model", () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  for (const id of ["live-a", "live-b", "live-c"]) {
    insertChunk(db, { id, filePath: `./${id}.md`, flType: "chunk", createdAt: now });
  }
  insertEmbedding(db, "live-a", new Float32Array([0.1]), "model-new");
  insertEmbedding(db, "live-b", new Float32Array([0.2]), "model-new");
  insertEmbedding(db, "live-c", new Float32Array([0.3]), "model-old");

  const counts = countEmbeddingsByModel(db);
  expect(Object.fromEntries(counts.map((r) => [r.model, r.cnt]))).toEqual({
    "model-new": 2,
    "model-old": 1,
  });

  db.close();
});

test("countEmbeddingsByModel ignores embeddings whose chunk is gone", () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  insertChunk(db, { id: "live", filePath: "./live.md", flType: "chunk", createdAt: now });
  insertEmbedding(db, "live", new Float32Array([0.1]), "model-new");

  // The state an older lore left behind: an embedding for a chunk that is gone.
  // On an outdated model it would otherwise raise a refresh the mind does not need.
  insertEmbedding(db, "chunk-gone-1", new Float32Array([0.2]), "model-old");
  insertEmbedding(db, "chunk-gone-2", new Float32Array([0.3]), "model-new");

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM embeddings").get()?.c).toBe(3);

  const counts = countEmbeddingsByModel(db);
  expect(Object.fromEntries(counts.map((r) => [r.model, r.cnt]))).toEqual({ "model-new": 1 });
  expect(counts.reduce((sum, r) => sum + r.cnt, 0)).toBe(1);

  db.close();
});

test("countEmbeddingsByModel ignores superseded and archived chunks", () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  const concept = insertConcept(db, "c1");
  insertConceptVersion(db, concept.id, {
    lifecycle_status: "archived",
    archived_at: now,
  });

  // The same three shapes getAllEmbeddings already excludes. Their chunk rows
  // all exist, so the join alone lets every one of them through.
  insertChunk(db, {
    id: "archived-chunk",
    filePath: "./a.md",
    flType: "chunk",
    conceptId: concept.id,
    createdAt: now,
  });
  insertChunk(db, { id: "active-chunk", filePath: "./b.md", flType: "chunk", createdAt: now });
  insertChunk(db, {
    id: "superseded-chunk",
    filePath: "./c.md",
    flType: "chunk",
    supersedesId: "active-chunk",
    createdAt: now,
  });

  insertEmbedding(db, "archived-chunk", new Float32Array([1]), "model-old");
  insertEmbedding(db, "active-chunk", new Float32Array([1]), "model-old");
  insertEmbedding(db, "superseded-chunk", new Float32Array([1]), "model-new");

  // getAllEmbeddings returns superseded-chunk alone, so the count must agree.
  expect(getAllEmbeddings(db, "chunk").map((r) => r.chunk_id)).toEqual(["superseded-chunk"]);
  expect(Object.fromEntries(countEmbeddingsByModel(db).map((r) => [r.model, r.cnt]))).toEqual({
    "model-new": 1,
  });

  db.close();
});

test("countEmbeddingsByModel keeps source and journal rows, which carry no lifecycle", () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  insertChunk(db, { id: "src", filePath: "./s.ts", flType: "source", createdAt: now });
  insertChunk(db, { id: "jrn", filePath: "./j.md", flType: "journal", createdAt: now });
  insertEmbedding(db, "src", new Float32Array([0.1]), "code-model");
  insertEmbedding(db, "jrn", new Float32Array([0.2]), "text-model");

  expect(Object.fromEntries(countEmbeddingsByModel(db).map((r) => [r.model, r.cnt]))).toEqual({
    "code-model": 1,
    "text-model": 1,
  });

  db.close();
});

function addSymbol(db: Database, name: string): string {
  const sourceFileId = upsertSourceFile(db, {
    filePath: `src/${name}.ts`,
    language: "typescript",
    contentHash: `hash-${name}`,
    sizeBytes: 100,
    symbolCount: 1,
  }).id;
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

test("countSymbolEmbeddingsByModel counts the code lane's second table", () => {
  const db = createTestDb();

  // The lane the chunk count never reads. A code model change strands every row
  // here, and both readers filter on the model, so they return nothing.
  insertSymbolEmbedding(db, addSymbol(db, "alpha"), new Float32Array([0.1]), "code-new");
  insertSymbolEmbedding(db, addSymbol(db, "beta"), new Float32Array([0.2]), "code-new");
  insertSymbolEmbedding(db, addSymbol(db, "gamma"), new Float32Array([0.3]), "code-old");

  expect(Object.fromEntries(countSymbolEmbeddingsByModel(db).map((r) => [r.model, r.cnt]))).toEqual(
    { "code-new": 2, "code-old": 1 },
  );

  db.close();
});

test("countSymbolEmbeddingsByModel ignores embeddings whose symbol is gone", () => {
  const db = createTestDb();

  insertSymbolEmbedding(db, addSymbol(db, "live"), new Float32Array([0.1]), "code-new");
  // What a replaced symbol left behind. Binding extraction reads its cache
  // against the live symbol list, so this row reaches no reader. On an outdated
  // model it would otherwise raise a refresh the mind does not need.
  insertSymbolEmbedding(db, "symbol-gone", new Float32Array([0.2]), "code-old");

  expect(db.query<{ c: number }, []>("SELECT COUNT(*) c FROM symbol_embeddings").get()?.c).toBe(2);

  const counts = countSymbolEmbeddingsByModel(db);
  expect(Object.fromEntries(counts.map((r) => [r.model, r.cnt]))).toEqual({ "code-new": 1 });
  expect(counts.reduce((sum, r) => sum + r.cnt, 0)).toBe(1);

  db.close();
});

test("countSymbolEmbeddingsByModel and countEmbeddingsByModel report separate lanes", () => {
  const db = createTestDb();
  const now = new Date().toISOString();

  // One code model change, two tables. The source chunk moves with the refresh;
  // the symbol row does not, unless status counts it.
  insertChunk(db, { id: "src", filePath: "./s.ts", flType: "source", createdAt: now });
  insertEmbedding(db, "src", new Float32Array([0.1]), "code-new");
  insertSymbolEmbedding(db, addSymbol(db, "stale"), new Float32Array([0.2]), "code-old");

  expect(Object.fromEntries(countEmbeddingsByModel(db).map((r) => [r.model, r.cnt]))).toEqual({
    "code-new": 1,
  });
  expect(Object.fromEntries(countSymbolEmbeddingsByModel(db).map((r) => [r.model, r.cnt]))).toEqual(
    { "code-old": 1 },
  );

  db.close();
});
