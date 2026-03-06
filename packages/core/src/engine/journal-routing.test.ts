import { expect, test } from "bun:test";
import { insertNarrative } from "@/db/narratives.ts";
import { insertConcept } from "@/db/index.ts";
import { resolveJournalConceptDesignations, loadJournalConceptDesignations } from "./journal-routing.ts";
import { createTestDb } from "../../test/support/db.ts";

test("resolveJournalConceptDesignations auto-inherits the single create/update target", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "auth-model");
  const narrative = insertNarrative(db, "auth-work", "update auth", null, [
    { op: "update", concept: "auth-model" },
  ]);

  const resolved = resolveJournalConceptDesignations(db, narrative, []);
  expect(resolved.designations).toEqual(["auth-model"]);
  expect(resolved.conceptRefs).toEqual([concept.id]);
  expect(resolved.autoInherited).toBe(true);

  db.close();
});

test("resolveJournalConceptDesignations allows create targets before the concept exists", () => {
  const db = createTestDb();
  const narrative = insertNarrative(db, "new-work", "create a concept", null, [
    { op: "create", concept: "new-subsystem" },
  ]);

  const resolved = resolveJournalConceptDesignations(db, narrative, ["new-subsystem"]);
  expect(resolved.designations).toEqual(["new-subsystem"]);
  expect(resolved.conceptRefs).toEqual([]);
  expect(resolved.autoInherited).toBe(false);

  db.close();
});

test("resolveJournalConceptDesignations rejects missing concepts when no target can be inherited", () => {
  const db = createTestDb();
  const narrative = insertNarrative(db, "explore", "look around");

  expect(() => resolveJournalConceptDesignations(db, narrative, [])).toThrow(
    /needs explicit concepts/i,
  );

  db.close();
});

test("resolveJournalConceptDesignations rejects designations outside declared targets", () => {
  const db = createTestDb();
  insertConcept(db, "auth-model");
  insertConcept(db, "cache-layer");
  const narrative = insertNarrative(db, "auth-only", "update auth", null, [
    { op: "update", concept: "auth-model" },
  ]);

  expect(() => resolveJournalConceptDesignations(db, narrative, ["cache-layer"])).toThrow(
    /outside the declared narrative targets/i,
  );

  db.close();
});

test("loadJournalConceptDesignations falls back to stored concept refs", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "auth-model");

  const designations = loadJournalConceptDesignations(db, {
    concept_designations: null,
    concept_refs: JSON.stringify([concept.id]),
  });

  expect(designations).toEqual(["auth-model"]);
  db.close();
});
