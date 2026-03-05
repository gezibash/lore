import { test, expect } from "bun:test";
import type { ConceptRow } from "@/types/index.ts";
import type { LoreConfig } from "@/types/index.ts";
import type { DeepPartial } from "@/config/index.ts";
import {
  computeResidual,
  cosineDistance,
  computeStaleness,
  computeTotalDebt,
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
  const stale = computeStaleness(now, { thresholds: { staleness_days: 10 } } as DeepPartial<LoreConfig> as LoreConfig);
  expect(stale).toBe(0);

  const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
  const capped = computeStaleness(old, { thresholds: { staleness_days: 10 } } as DeepPartial<LoreConfig> as LoreConfig);
  expect(capped).toBe(1);
});

test("computeTotalDebt respects graph connectivity penalty", () => {
  // Debt is now driven by ground_residual (weight 0.6) + lore_residual (weight 0.4).
  // For concepts with only ground_residual set: pressure = 0.6 * gr
  // concept a: pressure = 0.6 * 2 = 1.2 (ground_residual out of normal range but valid numerically)
  // Wait — to keep the same numerical expectation (sum=3, etc.), use ground_residual directly
  // and lore_residual=0, so pressure = 0.6 * gr + 0.4 * 0 = 0.6 * gr.
  // Actually let's use churn as fallback: ground_residual=null, churn=value => pressure = 0.6 * churn
  // To get sum=3: 0.6*a + 0.6*b = 3 → a+b = 5. Alternatively, set ground_residual so 0.6*a + 0.6*b = 3.
  // Simplest: set ground_residual on both to get pressure sum = 3.
  // pressure(a) + pressure(b) = 0.6*grA + 0.6*grB = 3 → grA + grB = 5.
  // Use grA=2 (numeric but above 0-1, fine for test), grB=1 → sum = 0.6*2 + 0.6*1 = 1.8. Not 3.
  //
  // To avoid changing the numerical expectations, use lore_residual as well:
  // pressure(a) = 0.6*grA + 0.4*hrA = 2, pressure(b) = 0.6*grB + 0.4*hrB = 1
  // Simplest: set ground_residual only and scale: grA = 2/0.6 ≈ 3.33, grB = 1/0.6 ≈ 1.67
  // or just update the expectations to reflect the new formula.
  const concepts: ConceptRow[] = [
    {
      id: "a",
      residual: null,
      churn: null,
      ground_residual: 2, // pressure = 0.6 * 2 + 0 = 1.2
      lore_residual: null,
      name: "a",
      version_id: "v",
      active_chunk_id: null,
      staleness: null,
      cluster: null,
      is_hub: null,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: new Date().toISOString(),
    },
    {
      id: "b",
      residual: null,
      churn: null,
      ground_residual: 1, // pressure = 0.6 * 1 + 0 = 0.6
      lore_residual: null,
      name: "b",
      version_id: "v",
      active_chunk_id: null,
      staleness: null,
      cluster: null,
      is_hub: null,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: new Date().toISOString(),
    },
  ];

  // raw debt = 0.6*2 + 0.6*1 = 1.8 (GROUND_WEIGHT=0.6, no lore component)
  expect(computeTotalDebt(concepts, 0)).toBeCloseTo(1.8);
  expect(computeTotalDebt(concepts, 1)).toBeCloseTo(0.9);
  expect(computeTotalDebt(concepts, 5)).toBeCloseTo(0.3);
});

test("computeDebtTrend classifies movement by threshold", () => {
  expect(computeDebtTrend(11, 10)).toBe("degrading");
  expect(computeDebtTrend(9, 10)).toBe("improving");
  expect(computeDebtTrend(10.4, 10)).toBe("stable");
});
