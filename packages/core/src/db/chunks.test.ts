import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import { insertChunk } from "./chunks.ts";
import {
  getActiveChunks,
  getChunkCount,
  assignChunkToConcept,
  getChunkConceptId,
  getChunksForConcept,
  getJournalChunksForNarrative,
  deleteSourceChunksForFile,
  deleteDocChunksForFile,
  countOrphanedChunkRows,
  deleteOrphanedChunkRows,
} from "./chunks.ts";
import { insertEmbedding } from "./embeddings.ts";
import { insertFtsContent } from "./fts.ts";

function makeChunkId(prefix: string, idx: number): string {
  return `${prefix}-${idx}`;
}

test("getActiveChunks excludes superseded chunks", () => {
  const db = createTestDb();

  insertChunk(db, {
    id: makeChunkId("c", 1),
    filePath: "./c1.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: makeChunkId("c", 2),
    filePath: "./c2.md",
    flType: "chunk",
    supersedesId: makeChunkId("c", 1),
    createdAt: new Date(Date.now() + 1000).toISOString(),
  });
  insertChunk(db, {
    id: makeChunkId("j", 1),
    filePath: "./j1.md",
    flType: "journal",
    createdAt: new Date().toISOString(),
  });

  const active = getActiveChunks(db);
  expect(active.map((c) => c.id)).toEqual([makeChunkId("c", 2)]);
  expect(getChunkCount(db)).toBe(1);

  db.close();
});

test("assignChunkToConcept uses latest mapping", () => {
  const db = createTestDb();

  insertChunk(db, {
    id: makeChunkId("map", 1),
    filePath: "./map.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });

  assignChunkToConcept(db, makeChunkId("map", 1), "concept-a");
  assignChunkToConcept(db, makeChunkId("map", 1), "concept-b");

  expect(getChunkConceptId(db, makeChunkId("map", 1))).toBe("concept-b");
  db.close();
});

test("getChunksForConcept and getJournalChunksForNarrative query as expected", () => {
  const db = createTestDb();
  const conceptId = "concept-1";

  insertChunk(db, {
    id: "chunk-early",
    filePath: "./early.md",
    flType: "chunk",
    conceptId,
    createdAt: "2024-01-01T00:00:00.000Z",
  });
  insertChunk(db, {
    id: "chunk-late",
    filePath: "./late.md",
    flType: "chunk",
    conceptId,
    createdAt: "2024-01-02T00:00:00.000Z",
  });
  insertChunk(db, {
    id: "chunk-j",
    filePath: "./journal.md",
    flType: "journal",
    narrativeId: "narrative-1",
    createdAt: "2024-01-03T00:00:00.000Z",
  });

  expect(getChunksForConcept(db, conceptId).map((c) => c.id)).toEqual([
    "chunk-early",
    "chunk-late",
  ]);
  expect(getJournalChunksForNarrative(db, "narrative-1").map((c) => c.id)).toEqual(["chunk-j"]);

  db.close();
});

function seedChunkWithDependents(db: Database, id: string, flType: "source" | "doc"): void {
  insertChunk(db, {
    id,
    filePath: `./${id}.md`,
    flType,
    createdAt: new Date().toISOString(),
    sourceFilePath: "src/thing.ts",
  });
  insertEmbedding(db, id, new Float32Array([1, 0, 0, 0]), "test-embed");
  insertFtsContent(db, "body text", id);
  assignChunkToConcept(db, id, "concept-x");
  db.run(
    `INSERT INTO chunk_refs (id, chunk_id, file_path, content_hash, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    [`ref-${id}`, id, "src/thing.ts", "hash", new Date().toISOString()],
  );
}

test("deleting a file's chunks deletes every row keyed to them", () => {
  const db = createTestDb();

  seedChunkWithDependents(db, "source-1", "source");
  seedChunkWithDependents(db, "doc-1", "doc");

  deleteSourceChunksForFile(db, "src/thing.ts");
  expect(countOrphanedChunkRows(db)).toEqual({
    embeddings: 0,
    chunk_refs: 0,
    chunk_concept_map: 0,
    content_fts: 0,
  });

  deleteDocChunksForFile(db, "src/thing.ts");
  expect(countOrphanedChunkRows(db)).toEqual({
    embeddings: 0,
    chunk_refs: 0,
    chunk_concept_map: 0,
    content_fts: 0,
  });
  expect(getChunkCount(db)).toBe(0);

  db.close();
});

test("deleteOrphanedChunkRows clears rows a past chunk delete left behind", () => {
  const db = createTestDb();

  seedChunkWithDependents(db, "stale-1", "source");
  seedChunkWithDependents(db, "kept-1", "doc");
  // The leak this repairs: chunks gone, dependents left.
  db.run("DELETE FROM chunks WHERE id = 'stale-1'");

  expect(countOrphanedChunkRows(db)).toEqual({
    embeddings: 1,
    chunk_refs: 1,
    chunk_concept_map: 1,
    content_fts: 1,
  });

  expect(deleteOrphanedChunkRows(db)).toEqual({
    embeddings: 1,
    chunk_refs: 1,
    chunk_concept_map: 1,
    content_fts: 1,
  });

  expect(countOrphanedChunkRows(db)).toEqual({
    embeddings: 0,
    chunk_refs: 0,
    chunk_concept_map: 0,
    content_fts: 0,
  });
  // The live chunk keeps its rows.
  expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM embeddings").get()?.n).toBe(1);

  db.close();
});
