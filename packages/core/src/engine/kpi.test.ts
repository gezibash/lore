import { expect, test } from "bun:test";
import { LoreEngine } from "./index.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";

test("kpi log/goal/status: creation needs a direction, deltas and gaps follow it", async () => {
  const loreRoot = createTempDir("lore-root-");
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });

  try {
    await engine.register(codePath, "kpi-target");

    await expect(engine.kpiLog("p95-latency", 120, { codePath })).rejects.toMatchObject({
      code: "KPI_NOT_FOUND",
    });

    const first = await engine.kpiLog("p95-latency", 120, {
      codePath,
      direction: "down",
      unit: "ms",
      meta: { bench: "httpx" },
    });
    expect(first.created_kpi).toBe(true);
    expect(first.kpi.latest?.value).toBe(120);
    expect(first.kpi.previous).toBeNull();
    expect(first.kpi.delta_toward_goal).toBeNull();
    expect(first.kpi.goal).toBeNull();
    expect(first.reading.meta).toEqual({ bench: "httpx" });
    expect(first.reading.narrative).toBeNull();

    const goal = engine.kpiGoal("p95-latency", 100, { codePath });
    expect(goal.created_kpi).toBe(false);
    expect(goal.kpi.gap).toBe(20);
    expect(goal.kpi.goal_met).toBe(false);

    // Lower is better: 120 → 110 is +10 toward the goal.
    const second = await engine.kpiLog("P95-Latency", 110, { codePath });
    expect(second.created_kpi).toBe(false);
    expect(second.kpi.delta_toward_goal).toBe(10);
    expect(second.kpi.gap).toBe(10);

    const third = await engine.kpiLog("p95-latency", 95, { codePath });
    expect(third.kpi.goal_met).toBe(true);
    expect(third.kpi.gap).toBe(0);

    // Goal can be tightened; the history is append-only.
    engine.kpiGoal("p95-latency", 90, { codePath });
    const [status] = engine.kpiStatus({ codePath, name: "p95-latency", limit: 2 });
    expect(status?.goal).toBe(90);
    expect(status?.goal_met).toBe(false);
    expect(status?.reading_count).toBe(3);
    expect(status?.recent.map((r) => r.value)).toEqual([95, 110]);

    // An up-direction KPI with no goal still reports a signed delta.
    await engine.kpiLog("recall", 0.5, { codePath, direction: "up" });
    const up = await engine.kpiLog("recall", 0.4, { codePath });
    expect(up.kpi.delta_toward_goal).toBeCloseTo(-0.1);
    expect(engine.kpiStatus({ codePath }).map((k) => k.name)).toEqual(["p95-latency", "recall"]);

    expect(() => engine.kpiStatus({ codePath, name: "nope" })).toThrow(/not found/);
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(codePath);
  }
});

test("kpi readings attach to the sole open narrative by default, or a named one", async () => {
  const loreRoot = createTempDir("lore-root-");
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });

  try {
    await engine.register(codePath, "kpi-narrative");
    await engine.open("speedup", "Make it fast", { codePath });

    const auto = await engine.kpiLog("tps", 10, { codePath, direction: "up" });
    expect(auto.reading.narrative).toBe("speedup");

    await engine.open("second", "Another thread", { codePath });
    const ambiguous = await engine.kpiLog("tps", 11, { codePath });
    expect(ambiguous.reading.narrative).toBeNull();

    const named = await engine.kpiLog("tps", 12, { codePath, narrative: "second" });
    expect(named.reading.narrative).toBe("second");

    await expect(engine.kpiLog("tps", 13, { codePath, narrative: "missing" })).rejects.toThrow(
      /not found/,
    );
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(codePath);
  }
});
