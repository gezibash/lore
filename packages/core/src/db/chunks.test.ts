import { test, expect } from "bun:test";
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
} from "./chunks.ts";
import { insertEmbedding, getEmbeddingForChunk } from "./embeddings.ts";

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

function countEmbeddings(db: ReturnType<typeof createTestDb>): number {
  return (
    db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM embeddings").get()?.count ?? 0
  );
}

test("deleteSourceChunksForFile removes the embeddings of the deleted chunks", () => {
  const db = createTestDb();

  for (const [id, path] of [
    ["src-1", "src/a.ts"],
    ["src-2", "src/a.ts"],
    ["src-3", "src/b.ts"],
  ] as const) {
    insertChunk(db, {
      id,
      filePath: `./${id}.md`,
      flType: "source",
      sourceFilePath: path,
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    insertEmbedding(db, id, new Float32Array([0.1, 0.2, 0.3]), "test-model");
  }

  expect(countEmbeddings(db)).toBe(3);

  deleteSourceChunksForFile(db, "src/a.ts");

  expect(countEmbeddings(db)).toBe(1);
  expect(getEmbeddingForChunk(db, "src-3")).not.toBeNull();

  db.close();
});

test("deleteDocChunksForFile removes the embeddings of the deleted chunks", () => {
  const db = createTestDb();

  insertChunk(db, {
    id: "doc-1",
    filePath: "./doc-1.md",
    flType: "doc",
    sourceFilePath: "docs/readme.md",
    createdAt: "2024-01-01T00:00:00.000Z",
  });
  insertEmbedding(db, "doc-1", new Float32Array([0.4, 0.5, 0.6]), "test-model");

  deleteDocChunksForFile(db, "docs/readme.md");

  expect(countEmbeddings(db)).toBe(0);

  db.close();
});

test("re-ingesting a changed source file leaves no orphan embeddings", () => {
  const db = createTestDb();

  // First ingest: two chunks with the ids of the first version.
  for (const id of ["v1-a", "v1-b"]) {
    insertChunk(db, {
      id,
      filePath: `./${id}.md`,
      flType: "source",
      sourceFilePath: "src/changed.ts",
      createdAt: "2024-01-01T00:00:00.000Z",
    });
    insertEmbedding(db, id, new Float32Array([0.1, 0.2, 0.3]), "test-model");
  }

  // Second ingest: the scanner deletes the chunks, then writes new ids.
  deleteSourceChunksForFile(db, "src/changed.ts");
  insertChunk(db, {
    id: "v2-a",
    filePath: "./v2-a.md",
    flType: "source",
    sourceFilePath: "src/changed.ts",
    createdAt: "2024-01-02T00:00:00.000Z",
  });
  insertEmbedding(db, "v2-a", new Float32Array([0.7, 0.8, 0.9]), "test-model");

  const orphans =
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM embeddings e
         LEFT JOIN chunks c ON c.id = e.chunk_id
         WHERE c.id IS NULL`,
      )
      .get()?.count ?? 0;

  expect(orphans).toBe(0);
  expect(countEmbeddings(db)).toBe(1);

  db.close();
});
