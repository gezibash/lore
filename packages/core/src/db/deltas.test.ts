import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  insertNarrative,
  getOpenNarrativeByName,
  getOpenNarratives,
  updateNarrativeMetrics,
  closeNarrative,
  abandonNarrative,
  getDanglingNarratives,
  getNarrative,
} from "./narratives.ts";

test("insertNarrative and getOpenNarrativeByName", () => {
  const db = createTestDb();
  const narrative = insertNarrative(db, "review", "test", null);
  const open = getOpenNarrativeByName(db, "review");

  expect(open?.id).toBe(narrative.id);
  expect(open?.status).toBe("open");
  expect(open?.entry_count).toBe(0);

  db.close();
});

test("getOpenNarratives returns only open entries in order", () => {
  const db = createTestDb();
  insertNarrative(db, "a", "intent", null);
  insertNarrative(db, "b", "intent", null);

  const narratives = getOpenNarratives(db);
  expect(narratives.map((d) => d.status)).toEqual(["open", "open"]);
  expect(narratives.map((d) => d.name).sort()).toEqual(["a", "b"]);

  db.close();
});

test("updateNarrativeMetrics appends version preserving identity", () => {
  const db = createTestDb();
  const narrative = insertNarrative(db, "metric", "intent", null);

  updateNarrativeMetrics(db, narrative.id, { theta: 1, convergence: 2, magnitude: 3, entry_count: 4 });

  const current = getNarrative(db, narrative.id);
  expect(current?.entry_count).toBe(4);
  expect(current?.theta).toBe(1);
  expect(current?.convergence).toBe(2);
  expect(current?.magnitude).toBe(3);
  expect(current?.status).toBe("open");

  db.close();
});

test("closeNarrative and abandonNarrative set status and closed timestamp", () => {
  const db = createTestDb();
  const closed = insertNarrative(db, "close", "intent", null);
  const abandoned = insertNarrative(db, "abandon", "intent", null);

  closeNarrative(db, closed.id);
  abandonNarrative(db, abandoned.id);

  expect(getNarrative(db, closed.id)?.status).toBe("closed");
  expect(getNarrative(db, abandoned.id)?.status).toBe("abandoned");
  expect(getNarrative(db, closed.id)?.closed_at).not.toBeNull();
  expect(getNarrative(db, abandoned.id)?.closed_at).not.toBeNull();

  db.close();
});

test("getDanglingNarratives respects age threshold", () => {
  const db = createTestDb();
  const dangling = insertNarrative(db, "old", "intent", null);
  const fresh = insertNarrative(db, "fresh", "intent", null);

  const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  db.run("UPDATE narratives SET opened_at = ? WHERE id = ?", [ancient, dangling.id]);

  const old = getDanglingNarratives(db, 0.5);
  const ids = old.map((d) => d.id);

  expect(ids).toContain(dangling.id);
  expect(ids).not.toContain(fresh.id);

  db.close();
});
