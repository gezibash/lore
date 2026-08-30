import { test, expect } from "bun:test";
import type { ConceptRow } from "@/types/index.ts";
import type { LoreConfig } from "@/types/index.ts";
import type { DeepPartial } from "@/config/index.ts";
import {
  computeResidual,
  cosineDistance,
  computeStaleness,
  computeDebtTrend,
} from "./residuals.ts";

test("computeResidual returns 0 when no previous embedding exists", () => {
  const current = new Float32Array([1, 2, 3]);
  expect(computeResidual(current, null)).toBe(0);
});

test("cosineDistance handles identical and opposite vectors", () => {
  const identicalA = new Float32Array([1, 0, 0]);
  const identicalB = new Float32Array([1, 0, 0]);
  expect(cosineDistance(identicalA, identicalB)).toBeCloseTo(0);

  const opposite = new Float32Array([-1, 0, 0]);
  expect(cosineDistance(identicalA, opposite)).toBeCloseTo(2);
});

test("computeStaleness clamps to [0, 1]", () => {
  const config = {
    thresholds: { staleness_days: 10 },
  } as DeepPartial<LoreConfig> as LoreConfig;
  const days = (n: number) => new Date(Date.now() + n * 24 * 60 * 60 * 1000).toISOString();

  // A timestamp the clock puts in the future reads as fresh, not as a negative
  // score. Now itself is milliseconds old by the time this runs, so it belongs
  // with the fractional case below, not with an exact-zero assertion.
  expect(computeStaleness(days(1), config)).toBe(0);
  expect(computeStaleness(days(-20), config)).toBe(1);
  expect(computeStaleness(days(-5), config)).toBeCloseTo(0.5, 3);
  expect(computeStaleness(new Date().toISOString(), config)).toBeCloseTo(0, 3);
});

test("computeDebtTrend classifies movement by RELATIVE threshold", () => {
  // ±10% relative (spec §8): size-invariant, unlike the old ±0.5 absolute.
  expect(computeDebtTrend(0.34, 0.3)).toBe("degrading"); // +13%
  expect(computeDebtTrend(0.26, 0.3)).toBe("improving"); // -13%
  expect(computeDebtTrend(0.31, 0.3)).toBe("stable"); // +3%
  expect(computeDebtTrend(0.1, 0)).toBe("degrading"); // from zero, any debt degrades
  expect(computeDebtTrend(0, 0)).toBe("stable");
});
