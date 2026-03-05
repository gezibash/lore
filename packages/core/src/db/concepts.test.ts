import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertConcept,
  getConcept,
  insertConceptVersion,
  getConceptByName,
  getActiveConcepts,
  getActiveConceptCount,
  isConceptNameTaken,
} from "./concepts.ts";

test("insertConcept and getConcept return latest concept snapshot", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "alpha-concept");
  const found = getConcept(db, concept.id);

  expect(found?.name).toBe("alpha-concept");
  expect(found?.id).toBe(concept.id);
  db.close();
});

test("insertConceptVersion updates active row while preserving append-only history", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "beta-concept");

  insertConceptVersion(db, concept.id, {
    name: "beta-concept-v2",
    residual: 0.5,
    staleness: 0.2,
  });

  const current = getConcept(db, concept.id);
  expect(current?.name).toBe("beta-concept-v2");
  expect(current?.residual).toBe(0.5);
  expect(current?.staleness).toBe(0.2);

  const byName = getConceptByName(db, "beta-concept-v2");
  expect(byName?.id).toBe(concept.id);
  db.close();
});

test("isConceptNameTaken handles case-insensitive and excludes IDs", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "Gamma-Concept");

  expect(isConceptNameTaken(db, "gamma-concept")).toBe(true);

  insertConceptVersion(db, concept.id, { name: "Gamma-Concept" });
  expect(isConceptNameTaken(db, "Gamma-Concept", { excludeId: concept.id })).toBe(false);

  insertConcept(db, "gamma-CONCEPT");
  expect(isConceptNameTaken(db, "Gamma-Concept")).toBe(true);

  db.close();
});

test("getActiveConcepts excludes archived rows", () => {
  const db = createTestDb();
  insertConcept(db, "active-concept");
  const archived = insertConcept(db, "old-concept");

  insertConceptVersion(db, archived.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
  });

  const concepts = getActiveConcepts(db);
  expect(concepts.length).toBe(1);
  expect(concepts[0]!.name).toBe("active-concept");
  expect(getActiveConceptCount(db)).toBe(1);
  db.close();
});
