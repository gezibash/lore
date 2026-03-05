import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertSnapshot, getSnapshotsForNarrative } from "./snapshots.ts";

test("insertSnapshot and getSnapshotsForNarrative", () => {
  const db = createTestDb();
  const id = insertSnapshot(db, "concept-id", "narrative-id", "embedding-id");

  const rows = getSnapshotsForNarrative(db, "narrative-id");
  expect(rows).toHaveLength(1);
  expect(rows[0]!.id).toBe(id);
  expect(rows[0]!.concept_id).toBe("concept-id");
  expect(rows[0]!.narrative_id).toBe("narrative-id");
  expect(rows[0]!.embedding_id).toBe("embedding-id");

  const empty = getSnapshotsForNarrative(db, "missing");
  expect(empty).toEqual([]);

  db.close();
});
