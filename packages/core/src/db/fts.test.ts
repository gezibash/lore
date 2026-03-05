import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertConcept, insertConceptVersion, insertChunk } from "./index.ts";
import { insertFtsContent, bm25Search } from "./fts.ts";

test("bm25Search scopes results to active chunk concepts", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "active");
  const archived = insertConcept(db, "archived");

  insertConceptVersion(db, archived.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
  });

  insertChunk(db, {
    id: "a",
    filePath: "./a.md",
    flType: "chunk",
    conceptId: concept.id,
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "b",
    filePath: "./b.md",
    flType: "chunk",
    conceptId: archived.id,
    createdAt: new Date().toISOString(),
  });

  insertFtsContent(db, "open concept content", "a");
  insertFtsContent(db, "archived concept content", "b");

  const hits = bm25Search(db, "content", "chunk", 10);
  const ids = hits.map((r) => r.chunkId);

  expect(ids).toContain("a");
  expect(ids).not.toContain("b");

  db.close();
});

test("bm25Search returns only chunk rows for chunk source", () => {
  const db = createTestDb();
  insertChunk(db, {
    id: "state",
    filePath: "./state.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "note",
    filePath: "./note.md",
    flType: "journal",
    createdAt: new Date().toISOString(),
  });

  insertFtsContent(db, "shared content", "state");
  insertFtsContent(db, "shared content", "note");

  const chunkHits = bm25Search(db, "shared", "chunk", 10);
  expect(chunkHits.length).toBe(1);
  expect(chunkHits[0]!.chunkId).toBe("state");

  db.close();
});

test("bm25Search can sanitize special chars", () => {
  const db = createTestDb();
  insertChunk(db, {
    id: "search",
    filePath: "./search.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertFtsContent(db, "alpha beta gamma", "search");

  const hits = bm25Search(db, "(alpha+gamma)", "chunk", 10);
  expect(hits[0]!.chunkId).toBe("search");

  db.close();
});

test("bm25Search excludes superseded chunks for chunk source", () => {
  const db = createTestDb();

  insertChunk(db, {
    id: "old",
    filePath: "./old.md",
    flType: "chunk",
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "current",
    filePath: "./current.md",
    flType: "chunk",
    supersedesId: "old",
    createdAt: new Date().toISOString(),
  });

  insertFtsContent(db, "identity model snapshot", "old");
  insertFtsContent(db, "identity model snapshot", "current");

  const hits = bm25Search(db, "identity model", "chunk", 10);
  const ids = hits.map((r) => r.chunkId);

  expect(ids).toContain("current");
  expect(ids).not.toContain("old");

  db.close();
});
