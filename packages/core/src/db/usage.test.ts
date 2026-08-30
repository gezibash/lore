import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { recordUsage, usageEventCount, usageFirstSeen, usageTotals } from "./usage.ts";
import { runMigrations } from "./migrations.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function event(over: Partial<Parameters<typeof recordUsage>[1]> = {}) {
  return {
    kind: "generation" as const,
    operation: "generate_integration",
    provider: "openrouter",
    model: "z-ai/glm-5.3-flash",
    input_tokens: 1000,
    output_tokens: 200,
    ...over,
  };
}

test("totals group by kind, operation, provider and model", () => {
  const db = freshDb();
  recordUsage(db, event());
  recordUsage(db, event());
  recordUsage(db, event({ operation: "executive_summary", input_tokens: 50, output_tokens: 10 }));
  recordUsage(
    db,
    event({ kind: "embedding", operation: "embed", model: "qwen3-embedding:8b", output_tokens: 0 }),
  );

  const totals = usageTotals(db);
  expect(totals.length).toBe(3);

  const integration = totals.find((t) => t.operation === "generate_integration")!;
  expect(integration.calls).toBe(2);
  expect(integration.input_tokens).toBe(2000);
  expect(integration.output_tokens).toBe(400);

  // Ordered by total tokens, so the heaviest line reads first.
  expect(totals[0]?.operation).toBe("generate_integration");
});

test("a since filter excludes older rows", () => {
  const db = freshDb();
  recordUsage(db, event());
  expect(usageEventCount(db)).toBe(1);

  const future = new Date(Date.now() + 60_000).toISOString();
  expect(usageEventCount(db, future)).toBe(0);
  expect(usageTotals(db, future)).toEqual([]);
});

test("recording never throws, so a bad row cannot break the work that earned it", () => {
  const db = new Database(":memory:"); // no migrations: the table is absent
  expect(() => recordUsage(db, event())).not.toThrow();
});

test("token counts are stored as non-negative integers", () => {
  const db = freshDb();
  recordUsage(db, event({ input_tokens: -5, output_tokens: 10.7 }));
  const totals = usageTotals(db);
  expect(totals[0]?.input_tokens).toBe(0);
  expect(totals[0]?.output_tokens).toBe(11);
});

test("first seen reports the window a total actually covers", () => {
  const db = freshDb();
  expect(usageFirstSeen(db)).toBeNull();
  recordUsage(db, event());
  expect(usageFirstSeen(db)).toBeTruthy();
});
