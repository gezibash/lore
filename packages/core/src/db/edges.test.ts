import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertEdge, getEdges } from "./edges.ts";
import { upsertManifest } from "./manifest.ts";

test("getEdges filters by explicit graph version", () => {
  const db = createTestDb();
  insertEdge(db, "a", "b", 0.42, "graph-v1");
  insertEdge(db, "c", "d", 0.3, "graph-v2");

  const edgesV1 = getEdges(db, "graph-v1");
  expect(edgesV1.map((e) => e.from_id)).toContain("a");
  expect(edgesV1.map((e) => e.to_id)).toContain("b");
  expect(edgesV1.every((e) => e.graph_version === "graph-v1")).toBe(true);

  db.close();
});

test("getEdges uses latest manifest graph version by default", () => {
  const db = createTestDb();
  upsertManifest(db, {
    concept_graph_version: "latest",
    chunk_count: 0,
    concept_count: 0,
    debt: 0,
    debt_trend: "stable",
    fiedler_value: 1,
  });

  insertEdge(db, "a", "b", 0.1, "latest");
  insertEdge(db, "c", "d", 0.2, "old");

  const edges = getEdges(db);
  expect(edges.map((e) => e.graph_version)).toEqual(["latest"]);
  expect(edges[0]!.from_id).toBe("a");

  db.close();
});

test("getEdges returns empty when manifest is missing", () => {
  const db = createTestDb();
  expect(getEdges(db)).toEqual([]);
  db.close();
});
