import { expect, test } from "bun:test";
import {
  getCurrentKpiGoal,
  getKpi,
  insertKpi,
  insertKpiGoal,
  insertKpiReading,
  listKpiReadings,
  listKpis,
} from "./kpis.ts";
import { createTestDb } from "../../test/support/db.ts";

test("kpi names normalize, goals version append-only, readings list newest first", () => {
  const db = createTestDb();
  try {
    insertKpi(db, { name: "  Recall@10 ", direction: "up", unit: "frac" });
    expect(getKpi(db, "recall@10")?.unit).toBe("frac");
    expect(listKpis(db).map((k) => k.name)).toEqual(["recall@10"]);

    insertKpiGoal(db, { kpiName: "recall@10", target: 0.7, setAt: "2026-08-01T00:00:00.000Z" });
    insertKpiGoal(db, { kpiName: "recall@10", target: 0.8, setAt: "2026-08-02T00:00:00.000Z" });
    expect(getCurrentKpiGoal(db, "Recall@10")?.target).toBe(0.8);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM kpi_goals").get()?.n).toBe(2);

    insertKpiReading(db, {
      kpiName: "recall@10",
      value: 0.5,
      createdAt: "2026-08-01T00:00:00.000Z",
    });
    insertKpiReading(db, {
      kpiName: "recall@10",
      value: 0.6,
      createdAt: "2026-08-02T00:00:00.000Z",
      gitHead: "abc1234",
      meta: { bench: "httpx" },
    });
    const readings = listKpiReadings(db, "recall@10");
    expect(readings.map((r) => r.value)).toEqual([0.6, 0.5]);
    expect(readings[0]?.meta_json).toBe('{"bench":"httpx"}');
    expect(readings[1]?.meta_json).toBeNull();
  } finally {
    db.close();
  }
});

test("kpi direction is constrained to up|down", () => {
  const db = createTestDb();
  try {
    expect(() =>
      db.run("INSERT INTO kpis (name, direction, created_at) VALUES ('x', 'sideways', 'now')"),
    ).toThrow();
  } finally {
    db.close();
  }
});
