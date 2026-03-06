import { expect, test } from "bun:test";
import { mapConcurrent } from "./async.ts";

test("mapConcurrent preserves input order", async () => {
  const results = await mapConcurrent([30, 10, 20], 2, async (value) => {
    await Bun.sleep(value);
    return value;
  });

  expect(results).toEqual([30, 10, 20]);
});

test("mapConcurrent respects the requested concurrency ceiling", async () => {
  let inFlight = 0;
  let peak = 0;

  const results = await mapConcurrent([1, 2, 3, 4, 5], 2, async (value) => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    await Bun.sleep(5);
    inFlight -= 1;
    return value * 2;
  });

  expect(results).toEqual([2, 4, 6, 8, 10]);
  expect(peak).toBe(2);
});
