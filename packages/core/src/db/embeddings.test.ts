import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertEmbedding,
  getEmbeddingForChunk,
  vectorSearch,
  getAllEmbeddings,
} from "./embeddings.ts";
import { insertConcept, insertConceptVersion } from "./concepts.ts";
import { insertChunk } from "./chunks.ts";

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
