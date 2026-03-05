import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { upsertManifest, getManifest } from "./manifest.ts";

test("upsertManifest and getManifest roundtrip", () => {
  const db = createTestDb();

  upsertManifest(db, {
    concept_graph_version: "graph-1",
    fiedler_value: 0.5,
    debt: 1.2,
    debt_trend: "stable",
    chunk_count: 3,
    concept_count: 2,
  });

  const row = getManifest(db);
  expect(row?.concept_graph_version).toBe("graph-1");
  expect(row?.fiedler_value).toBe(0.5);
  expect(row?.debt).toBe(1.2);

  upsertManifest(db, {
    debt: 2.0,
  });

  const refreshed = getManifest(db);
  expect(refreshed?.debt).toBe(2.0);
  expect(refreshed?.concept_graph_version).toBe("graph-1");
  expect(refreshed?.chunk_count).toBe(3);

  db.close();
});
