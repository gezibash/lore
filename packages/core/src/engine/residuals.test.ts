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
  const now = new Date().toISOString();
  const stale = computeStaleness(now, {
    thresholds: { staleness_days: 10 },
  } as DeepPartial<LoreConfig> as LoreConfig);
  expect(stale).toBe(0);

  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const capped = computeStaleness(old, {
    thresholds: { staleness_days: 10 },
  } as DeepPartial<LoreConfig> as LoreConfig);
  expect(capped).toBe(1);
});

test("computeDebtTrend classifies movement by RELATIVE threshold", () => {
  // ±10% relative (spec §8): size-invariant, unlike the old ±0.5 absolute.
  expect(computeDebtTrend(0.34, 0.3)).toBe("degrading"); // +13%
  expect(computeDebtTrend(0.26, 0.3)).toBe("improving"); // -13%
  expect(computeDebtTrend(0.31, 0.3)).toBe("stable"); // +3%
  expect(computeDebtTrend(0.1, 0)).toBe("degrading"); // from zero, any debt degrades
  expect(computeDebtTrend(0, 0)).toBe("stable");
});
