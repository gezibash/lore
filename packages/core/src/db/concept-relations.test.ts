import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertConcept } from "./concepts.ts";
import {
  upsertConceptRelation,
  deactivateConceptRelation,
  getConceptRelations,
  getActiveRelationNeighbors,
} from "./concept-relations.ts";

test("upsertConceptRelation inserts and reactivates relation", () => {
  const db = createTestDb();
  const a = insertConcept(db, "alpha");
  const b = insertConcept(db, "beta");

  const inserted = upsertConceptRelation(db, a.id, b.id, "depends_on", 0.8);
  expect(inserted.active).toBe(1);
  expect(inserted.weight).toBe(0.8);

  const removed = deactivateConceptRelation(db, a.id, b.id, "depends_on");
  expect(removed).toBe(1);

  const reactivated = upsertConceptRelation(db, a.id, b.id, "depends_on", 0.6);
  expect(reactivated.id).toBe(inserted.id);
  expect(reactivated.active).toBe(1);
  expect(reactivated.weight).toBe(0.6);

  const active = getConceptRelations(db);
  expect(active.length).toBe(1);
  expect(active[0]?.id).toBe(inserted.id);

  db.close();
});

test("getConceptRelations filters by concept id", () => {
  const db = createTestDb();
  const a = insertConcept(db, "alpha");
  const b = insertConcept(db, "beta");
  const c = insertConcept(db, "gamma");

  upsertConceptRelation(db, a.id, b.id, "depends_on", 1);
  upsertConceptRelation(db, c.id, a.id, "uses", 0.4);
  upsertConceptRelation(db, b.id, c.id, "related_to", 0.3);

  const relatedToAlpha = getConceptRelations(db, { conceptId: a.id });
  expect(relatedToAlpha.length).toBe(2);

  const neighbors = getActiveRelationNeighbors(db, a.id);
  expect(neighbors.length).toBe(2);

  db.close();
});
