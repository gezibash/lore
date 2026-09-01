import { expect, test, describe } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { countRuns, getRun, insertRun, listRuns, normalizeRunName } from "./runs.ts";

describe("run records", () => {
  test("a run keeps its inputs, outputs and provenance", () => {
    const db = createTestDb();
    const row = insertRun(db, {
      name: "sweep-42",
      outcome: "success",
      params: { lr: "0.003", seed: "7" },
      metrics: { auc: 0.812 },
      artifacts: ["results/sweep-42/plot.png"],
      note: "widened the search",
      gitHead: "abc123",
      loreCommitId: "cmt-1",
    });

    const read = getRun(db, row.id);
    expect(read?.name).toBe("sweep-42");
    expect(JSON.parse(read!.params_json!)).toEqual({ lr: "0.003", seed: "7" });
    expect(JSON.parse(read!.metrics_json!)).toEqual({ auc: 0.812 });
    expect(JSON.parse(read!.artifacts_json!)).toEqual(["results/sweep-42/plot.png"]);
    // Provenance is the reason a run is stored here and not in a scratch file.
    expect(read?.git_head).toBe("abc123");
    expect(read?.lore_commit_id).toBe("cmt-1");

    db.close();
  });

  test("empty inputs are stored as null, not as an empty object", () => {
    const db = createTestDb();
    const row = insertRun(db, { name: "bare", outcome: "success", params: {}, metrics: {} });

    // `{}` and `[]` read as "there were some" on the way out. Null says none.
    expect(getRun(db, row.id)?.params_json).toBeNull();
    expect(getRun(db, row.id)?.metrics_json).toBeNull();
    expect(getRun(db, row.id)?.artifacts_json).toBeNull();

    db.close();
  });

  test("a failed run is recorded like any other", () => {
    const db = createTestDb();
    const row = insertRun(db, {
      name: "sweep-43",
      outcome: "failure",
      params: { lr: "3.0" },
      note: "diverged",
    });

    // A configuration that does not work is the thing most often repeated by
    // accident, so it has to be as recordable as one that does.
    expect(getRun(db, row.id)?.outcome).toBe("failure");

    db.close();
  });

  test("the schema rejects an outcome nobody can interpret", () => {
    const db = createTestDb();
    expect(() => insertRun(db, { name: "x", outcome: "maybe" as unknown as "success" })).toThrow();
    db.close();
  });

  test("listing is newest first and narrows by name", () => {
    const db = createTestDb();
    insertRun(db, { name: "alpha", outcome: "success", createdAt: "2026-01-01T00:00:00.000Z" });
    insertRun(db, { name: "beta", outcome: "success", createdAt: "2026-01-02T00:00:00.000Z" });
    insertRun(db, { name: "alpha", outcome: "failure", createdAt: "2026-01-03T00:00:00.000Z" });

    expect(listRuns(db).map((r) => r.name)).toEqual(["alpha", "beta", "alpha"]);
    expect(listRuns(db, { name: "alpha" }).map((r) => r.outcome)).toEqual(["failure", "success"]);

    db.close();
  });

  test("since is inclusive of its own timestamp", () => {
    const db = createTestDb();
    insertRun(db, { name: "old", outcome: "success", createdAt: "2026-01-01T00:00:00.000Z" });
    insertRun(db, { name: "edge", outcome: "success", createdAt: "2026-01-02T00:00:00.000Z" });
    insertRun(db, { name: "new", outcome: "success", createdAt: "2026-01-03T00:00:00.000Z" });

    const names = listRuns(db, { since: "2026-01-02T00:00:00.000Z" }).map((r) => r.name);
    expect(names).toEqual(["new", "edge"]);

    db.close();
  });

  test("limit bounds the listing", () => {
    const db = createTestDb();
    for (let i = 0; i < 5; i++) {
      insertRun(db, { name: `r${i}`, outcome: "success" });
    }
    expect(countRuns(db)).toBe(5);
    expect(listRuns(db, { limit: 2 })).toHaveLength(2);
    db.close();
  });

  test("a run name is trimmed and cannot be empty", () => {
    expect(normalizeRunName("  sweep-42 ")).toBe("sweep-42");
    expect(() => normalizeRunName("   ")).toThrow(/cannot be empty/i);
  });
});
