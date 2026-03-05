import { expect, test } from "bun:test";
import type { ConceptRow } from "@/types/index.ts";
import { conceptLiveStaleness } from "./debt.ts";

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

test("conceptLiveStaleness includes ref drift", () => {
  const c = concept({ id: "c-drift", staleness: 0.1 });
  const drift = new Map<string, number>([["c-drift", 0.7]]);
  expect(conceptLiveStaleness(c, drift)).toBe(0.7);
});

test("conceptLiveStaleness preserves higher persisted staleness", () => {
  const c = concept({ id: "c-old", staleness: 0.9 });
  const drift = new Map<string, number>([["c-old", 0.7]]);
  expect(conceptLiveStaleness(c, drift)).toBe(0.9);
});
