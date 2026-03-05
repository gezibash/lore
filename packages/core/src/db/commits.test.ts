import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertCommit,
  getHeadCommit,
  walkHistory,
  diffCommitTrees,
  resolveRef,
} from "./commits.ts";
import { insertCommitTree } from "./commits.ts";
import { insertConcept } from "./concepts.ts";

test("insertCommit and walkHistory track commit ancestry", () => {
  const db = createTestDb();

  const first = insertCommit(db, null, null, null, "init");
  const second = insertCommit(db, null, first.id, null, "second");
  const third = insertCommit(db, null, second.id, null, "third");

  const head = getHeadCommit(db);
  expect(head).not.toBeNull();

  const history = walkHistory(db);
  expect(history.map((c) => c.id).sort()).toEqual([first.id, second.id, third.id].sort());

  const fromThird = walkHistory(db, third.id);
  expect(fromThird.map((c) => c.id)).toEqual([third.id, second.id, first.id]);

  db.close();
});

test("resolveRef supports main and main~N", () => {
  const db = createTestDb();

  const first = insertCommit(db, null, null, null, "init");
  const second = insertCommit(db, null, first.id, null, "second");
  const third = insertCommit(db, null, second.id, null, "third");

  // Make timestamps deterministic for the date-style ref test below
  db.run("UPDATE commits SET committed_at = ? WHERE id = ?", [
    "2024-01-01T00:00:00.000Z",
    first.id,
  ]);
  db.run("UPDATE commits SET committed_at = ? WHERE id = ?", [
    "2024-01-02T00:00:00.000Z",
    second.id,
  ]);
  db.run("UPDATE commits SET committed_at = ? WHERE id = ?", [
    "2024-01-03T00:00:00.000Z",
    third.id,
  ]);

  expect(resolveRef(db, "main")?.id).toBe(third.id);
  expect(resolveRef(db, "main~1")?.id).toBe(second.id);
  expect(resolveRef(db, "main~2")?.id).toBe(first.id);
  expect(resolveRef(db, "main@2024-01-02")?.id).toBe(second.id);
  expect(resolveRef(db, "bogus")).toBeNull();

  db.close();
});

test("diffCommitTrees reports rename and added/removed chunks", () => {
  const db = createTestDb();
  const conceptA = insertConcept(db, "auth-model").id;
  const conceptB = insertConcept(db, "archived-model").id;
  const conceptC = insertConcept(db, "new-model").id;

  const commitA = insertCommit(db, null, null, null, "before");
  const commitB = insertCommit(db, null, commitA.id, null, "after");

  insertCommitTree(db, commitA.id, [
    { conceptId: conceptA, chunkId: "chunk-a1", conceptName: "auth-model" },
    { conceptId: conceptB, chunkId: "chunk-b1", conceptName: "old-name" },
  ]);
  insertCommitTree(db, commitB.id, [
    { conceptId: conceptA, chunkId: "chunk-a2", conceptName: "renamed-auth" },
    { conceptId: conceptC, chunkId: "chunk-c1", conceptName: "new-model" },
  ]);

  const diff = diffCommitTrees(db, commitA.id, commitB.id);

  expect(diff.modified).toHaveLength(1);
  expect(diff.modified[0]!.conceptName).toBe("auth-model -> renamed-auth");
  expect(diff.added).toHaveLength(1);
  expect(diff.added[0]!.conceptName).toBe("new-model");
  expect(diff.removed).toHaveLength(1);
  expect(diff.removed[0]!.conceptName).toBe("old-name");

  db.close();
});
