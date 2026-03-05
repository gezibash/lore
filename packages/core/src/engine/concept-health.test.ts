import { expect, test } from "bun:test";
import type { ConceptRelationRow, ConceptRow } from "@/types/index.ts";
import {
  buildConceptHealthNeighbors,
  computeConceptHealthSignals,
  healSignal,
} from "./concept-health.ts";

function concept(overrides?: Partial<ConceptRow>): ConceptRow {
  return {
    version_id: "v1",
    id: "c1",
    name: "alpha",
    active_chunk_id: "chunk-1",
    residual: 0.2,
    churn: null,
    ground_residual: null,
    lore_residual: null,
    staleness: 0.4,
    cluster: 0,
    is_hub: 0,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
    inserted_at: "2026-02-24T00:00:00.000Z",
    ...overrides,
  };
}

function relation(overrides?: Partial<ConceptRelationRow>): ConceptRelationRow {
  return {
    id: "r1",
    from_concept_id: "c1",
    to_concept_id: "c2",
    relation_type: "depends_on",
    weight: 1,
    active: 1,
    created_at: "2026-02-24T00:00:00.000Z",
    updated_at: "2026-02-24T00:00:00.000Z",
    ...overrides,
  };
}

test("computeConceptHealthSignals includes critical multiplier and returns sorted top stale", () => {
  const concepts = [
    concept({ id: "c1", name: "alpha", residual: 0.1, staleness: 0.2 }),
    concept({ id: "c2", name: "beta", residual: 0.3, staleness: 0.8 }),
  ];

  const result = computeConceptHealthSignals({
    concepts,
    refDriftScoreByConcept: new Map([
      ["c1", 0],
      ["c2", 0.7],
    ]),
    relations: [relation()],
    criticalConceptIds: new Set(["c2"]),
    fiedlerValue: 0.2,
    baseDebt: 0.4,
  });

  expect(result.signals.length).toBe(2);
  expect(result.topStale[0]?.concept).toBe("beta");
  expect(result.topStale[0]?.critical).toBe(true);
  expect(result.debtAfterAdjust).toBeGreaterThanOrEqual(0);
});

test("buildConceptHealthNeighbors returns inbound and outbound links with stale signal", () => {
  const concepts = [
    concept({ id: "c1", name: "alpha" }),
    concept({ id: "c2", name: "beta" }),
    concept({ id: "c3", name: "gamma" }),
  ];
  const conceptsById = new Map(concepts.map((item) => [item.id, item]));

  const neighbors = buildConceptHealthNeighbors(
    "c1",
    [
      relation({ id: "r-out", from_concept_id: "c1", to_concept_id: "c2", relation_type: "uses" }),
      relation({
        id: "r-in",
        from_concept_id: "c3",
        to_concept_id: "c1",
        relation_type: "constrains",
      }),
    ],
    conceptsById,
    new Map([
      ["c2", 0.7],
      ["c3", 0.2],
    ]),
  );

  expect(neighbors.length).toBe(2);
  expect(neighbors.find((item) => item.direction === "outbound")?.concept).toBe("beta");
  expect(neighbors.find((item) => item.direction === "inbound")?.concept).toBe("gamma");
});

test("healSignal lowers staleness and residual based on pressure", () => {
  const healed = healSignal({
    concept: concept({ staleness: 0.9, residual: 0.7 }),
    finalStale: 0.8,
  });

  expect(healed.to_staleness).toBeLessThan(healed.from_staleness);
  expect(healed.to_residual).toBeLessThan(healed.from_residual);
});
