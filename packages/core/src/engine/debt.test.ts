import { expect, test } from "bun:test";
import type { ConceptRow } from "@/types/index.ts";
import { conceptDebtShare, conceptLiveStaleness, conceptPressure } from "./debt.ts";

function concept(overrides?: Partial<ConceptRow>): ConceptRow {
  return {
    version_id: "v1",
    id: "c1",
    name: "demo",
    active_chunk_id: "chunk-1",
    residual: 0,
    churn: null,
    ground_residual: null,
    lore_residual: null,
    staleness: 0.1,
    cluster: 0,
    is_hub: 0,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
    inserted_at: "2026-02-23T00:00:00.000Z",
    ...overrides,
  };
}

test("conceptLiveStaleness reads σ(c) from the snapshot", () => {
  const c = concept({ id: "c-drift", staleness: 0.1 });
  const snapshot = { sigmaByConcept: new Map<string, number>([["c-drift", 0.7]]) };
  expect(conceptLiveStaleness(c, snapshot)).toBe(0.7);
});

test("conceptLiveStaleness ignores the persisted staleness column", () => {
  // The column is frozen at 0 by close and never advanced by maintenance, so
  // a high stored value is stale data, not evidence — σ(c) wins outright.
  const c = concept({ id: "c-old", staleness: 0.9 });
  const snapshot = { sigmaByConcept: new Map<string, number>([["c-old", 0.2]]) };
  expect(conceptLiveStaleness(c, snapshot)).toBe(0.2);
});

test("conceptPressure is R(c) from the snapshot, ungrounded scoring 1", () => {
  const c = concept({ id: "c-unbound", ground_residual: 0.05 });
  const snapshot = {
    residualByConcept: new Map([
      [
        "c-unbound",
        { residual: 1, eDrift: 0, eEmbed: 0.05, eEmbedMeasured: true, ungrounded: true },
      ],
    ]),
  };
  expect(conceptPressure(c, snapshot)).toBe(1);
});

test("conceptDebtShare is p(c) · R(c) · fraction", () => {
  const c = concept({ id: "c-hot" });
  const snapshot = {
    residualByConcept: new Map([
      [
        "c-hot",
        { residual: 0.5, eDrift: 0.5, eEmbed: 0.1, eEmbedMeasured: true, ungrounded: false },
      ],
    ]),
    consultShareByConcept: new Map([["c-hot", 0.4]]),
  };
  expect(conceptDebtShare(c, snapshot)).toBeCloseTo(0.2);
  expect(conceptDebtShare(c, snapshot, 0.5)).toBeCloseTo(0.1);
});
