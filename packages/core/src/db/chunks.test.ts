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
} from "./chunks.ts";

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
