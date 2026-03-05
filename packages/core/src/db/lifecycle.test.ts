import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";
import {
  insertConcept,
  insertConceptVersion,
  getActiveConcepts,
  isConceptNameTaken,
} from "./concepts.ts";
import { insertCommit, insertCommitTree, diffCommitTrees } from "./commits.ts";
import { insertChunk } from "./chunks.ts";
import { insertFtsContent, bm25Search } from "./fts.ts";

function setupDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

test("active concept helpers hide archived concepts and preserve name checks", () => {
  const db = setupDb();

  const active = insertConcept(db, "auth-model");
  const archived = insertConcept(db, "legacy-auth-model");
  insertConceptVersion(db, archived.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
    lifecycle_reason: "retired",
    active_chunk_id: null,
  });

  const activeConcepts = getActiveConcepts(db);
  expect(activeConcepts.map((c) => c.name)).toEqual([active.name]);
  expect(isConceptNameTaken(db, "AUTH-MODEL")).toBe(true);
  expect(isConceptNameTaken(db, "legacy-auth-model")).toBe(true);

  db.close();
});

test("diffCommitTrees uses commit-time concept names", () => {
  const db = setupDb();

  const concept = insertConcept(db, "auth-model");
  const commitA = insertCommit(db, null, null, null, "init");
  insertCommitTree(db, commitA.id, [
    { conceptId: concept.id, chunkId: "chunk-v1", conceptName: "auth-model" },
  ]);

  insertConceptVersion(db, concept.id, { name: "identity-model" });
  const commitB = insertCommit(db, null, commitA.id, null, "rename + update");
  insertCommitTree(db, commitB.id, [
    { conceptId: concept.id, chunkId: "chunk-v2", conceptName: "identity-model" },
  ]);

  const diff = diffCommitTrees(db, commitA.id, commitB.id);
  expect(diff.modified.length).toBe(1);
  expect(diff.modified[0]!.conceptName).toBe("auth-model -> identity-model");

  db.close();
});

test("bm25Search excludes archived concept chunks for sourceType=chunk", () => {
  const db = setupDb();

  const active = insertConcept(db, "active-concept");
  const archived = insertConcept(db, "archived-concept");
  insertConceptVersion(db, archived.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
    lifecycle_reason: "deprecated",
    active_chunk_id: null,
  });

  insertChunk(db, {
    id: "chunk-active",
    filePath: "/tmp/chunk-active.md",
    flType: "chunk",
    conceptId: active.id,
    createdAt: new Date().toISOString(),
  });
  insertChunk(db, {
    id: "chunk-archived",
    filePath: "/tmp/chunk-archived.md",
    flType: "chunk",
    conceptId: archived.id,
    createdAt: new Date().toISOString(),
  });

  insertFtsContent(db, "lifecycle token active", "chunk-active");
  insertFtsContent(db, "lifecycle token archived", "chunk-archived");

  const hits = bm25Search(db, "lifecycle", "chunk", 10);
  expect(hits.some((h) => h.chunkId === "chunk-active")).toBe(true);
  expect(hits.some((h) => h.chunkId === "chunk-archived")).toBe(false);

  db.close();
});
