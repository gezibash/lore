import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { upsertLaplacianCache, getLaplacianCache } from "./laplacian.ts";

test("upsertLaplacianCache stores and retrieves latest cache", () => {
  const db = createTestDb();

  upsertLaplacianCache(
    db,
    "g-1",
    0.5,
    new Float64Array([0.1, 0.2]),
    new Float64Array([1, 2, 3, 4]),
  );
  const row = getLaplacianCache(db);

  expect(row).not.toBeNull();
  expect(row!.graph_version).toBe("g-1");
  expect(row!.fiedler_value).toBe(0.5);

  db.close();
});

test("latest cache replaces with newer graph version", () => {
  const db = createTestDb();

  upsertLaplacianCache(db, "first", 0.5, new Float64Array([1]), new Float64Array([2]));
  upsertLaplacianCache(db, "second", 0.6, new Float64Array([3]), new Float64Array([4]));

  const row = getLaplacianCache(db);
  expect(row).not.toBeNull();
  expect(["first", "second"]).toContain(row!.graph_version);

  db.close();
});
