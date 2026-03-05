import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertConcept } from "./concepts.ts";
import {
  upsertConceptTag,
  removeConceptTag,
  getConceptTags,
  hasConceptTag,
} from "./concept-tags.ts";

test("upsertConceptTag normalizes and deduplicates tags", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "alpha");

  const first = upsertConceptTag(db, concept.id, " Critical ");
  const second = upsertConceptTag(db, concept.id, "critical");

  expect(first.id).toBe(second.id);
  expect(second.tag).toBe("critical");

  const tags = getConceptTags(db, concept.id);
  expect(tags.map((t) => t.tag)).toEqual(["critical"]);
  expect(hasConceptTag(db, concept.id, "CRITICAL")).toBe(true);

  db.close();
});

test("removeConceptTag deletes only requested tag", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "alpha");
  upsertConceptTag(db, concept.id, "critical");
  upsertConceptTag(db, concept.id, "domain");

  const removed = removeConceptTag(db, concept.id, "critical");
  expect(removed).toBe(1);

  const tags = getConceptTags(db, concept.id);
  expect(tags.map((t) => t.tag)).toEqual(["domain"]);

  db.close();
});
