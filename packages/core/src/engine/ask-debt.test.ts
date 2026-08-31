import { expect, test } from "bun:test";
import { defaultConfig } from "@/config/index.ts";
import { insertChunk } from "@/db/chunks.ts";
import { closeNarrative, insertNarrative } from "@/db/narratives.ts";
import type { ConceptRow, RegistryEntry } from "@/types/index.ts";
import { createTestDb } from "../../test/support/db.ts";
import type { DebtSnapshot } from "./debt.ts";
import {
  askDebtBandWarning,
  askDebtRetrievalMultiplier,
  askDebtStalenessPenaltyMultiplier,
  computeAskDebtSnapshot,
} from "./ask-debt.ts";

function makeEntry(): RegistryEntry {
  const now = new Date().toISOString();
  return {
    code_path: process.cwd(),
    lore_path: process.cwd(),
    registered_at: now,
  };
}

function makeDebtSnapshot(overrides?: Partial<DebtSnapshot>): DebtSnapshot {
  return {
    debt: 0,
    debt_trend: "stable",
    persisted_debt: 0,
    live_debt: 0,
    refWarnings: new Map(),
    refDriftScoreByConcept: new Map(),
    residualByConcept: new Map(),
    sigmaByConcept: new Map(),
    consultShareByConcept: new Map(),
    symbolDriftWarnings: new Map(),
    ungroundedCount: 0,
    unmeasuredEmbedCount: 0,
    ...overrides,
  };
}

function makeConcept(overrides?: Partial<ConceptRow>): ConceptRow {
  return {
    version_id: "v1",
    id: "c1",
    name: "auth-core",
    active_chunk_id: "chunk-1",
    residual: 1,
    churn: 1,
    ground_residual: 1,
    lore_residual: 1,
    staleness: 1,
    cluster: 1,
    is_hub: 0,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
    inserted_at: new Date().toISOString(),
    ...overrides,
  };
}

test("ask-debt helpers map bands to multipliers and warnings", () => {
  expect(askDebtRetrievalMultiplier("healthy")).toBe(1);
  expect(askDebtRetrievalMultiplier("caution")).toBe(1.2);
  expect(askDebtRetrievalMultiplier("high")).toBe(1.4);
  expect(askDebtRetrievalMultiplier("critical")).toBe(1.6);

  expect(askDebtStalenessPenaltyMultiplier("healthy")).toBe(1);
  expect(askDebtStalenessPenaltyMultiplier("caution")).toBe(1.15);
  expect(askDebtStalenessPenaltyMultiplier("high")).toBe(1.25);
  expect(askDebtStalenessPenaltyMultiplier("critical")).toBe(1.5);

  expect(askDebtBandWarning("healthy")).toBeUndefined();
  expect(askDebtBandWarning("caution")).toBeUndefined();
  expect(askDebtBandWarning("high")).toContain("high");
  expect(askDebtBandWarning("critical")).toContain("critical");
});

test("snapshot debt IS the expected-error debt, banded by config", () => {
  const db = createTestDb();
  const snapshot = computeAskDebtSnapshot({
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [makeConcept()],
    debtSnapshot: makeDebtSnapshot({ debt: 0.42, persisted_debt: 0.42, live_debt: 0.42 }),
    coverage: { ratio: 1 },
    lake: {
      stale_source_files: 0,
      discovered_source_files: 10,
      stale_doc_files: 0,
      discovered_doc_files: 5,
    },
    embeddingStatus: { total: 10, stale: 0 },
  });
  // No second blend: the ask-time number is the one debt, passed through.
  expect(snapshot.debt).toBe(0.42);
  // 0.42 is above caution (0.30) and at/below high (0.50) → "high" band.
  expect(snapshot.band).toBe("high");
  db.close();
});

test("band cutoffs follow config.thresholds.debt_bands", () => {
  const db = createTestDb();
  const mk = (debt: number) =>
    computeAskDebtSnapshot({
      db,
      entry: makeEntry(),
      config: defaultConfig,
      concepts: [makeConcept()],
      debtSnapshot: makeDebtSnapshot({ debt, persisted_debt: debt, live_debt: debt }),
      coverage: { ratio: 1 },
      lake: {
        stale_source_files: 0,
        discovered_source_files: 1,
        stale_doc_files: 0,
        discovered_doc_files: 1,
      },
      embeddingStatus: { total: 1, stale: 0 },
    }).band;
  expect(mk(0.1)).toBe("healthy");
  expect(mk(0.2)).toBe("caution");
  expect(mk(0.45)).toBe("high");
  expect(mk(0.8)).toBe("critical");
  db.close();
});

test("a concept-less mind is unmeasured: null debt, caution band", () => {
  const db = createTestDb();
  const snapshot = computeAskDebtSnapshot({
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [],
    debtSnapshot: makeDebtSnapshot({ debt: 0 }),
    coverage: { ratio: 0 },
    lake: {
      stale_source_files: 0,
      discovered_source_files: 0,
      stale_doc_files: 0,
      discovered_doc_files: 0,
    },
    embeddingStatus: { total: 0, stale: 0 },
  });
  expect(snapshot.debt).toBeNull();
  expect(snapshot.band).toBe("caution"); // retrieve wide, warn mildly — not "healthy"
  db.close();
});

test("freshness and coverage are reported as axes, never blended into debt", () => {
  const db = createTestDb();
  const dirty = computeAskDebtSnapshot({
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [makeConcept()],
    debtSnapshot: makeDebtSnapshot({ debt: 0.1, persisted_debt: 0.1, live_debt: 0.1 }),
    coverage: { ratio: 0 }, // 100% coverage gap
    lake: {
      stale_source_files: 9,
      discovered_source_files: 10,
      stale_doc_files: 3,
      discovered_doc_files: 12,
    },
    embeddingStatus: { total: 10, stale: 10 },
  });
  // Axes report the degradation…
  expect(dirty.components.coverage_gap).toBeCloseTo(1);
  expect(dirty.components.code_freshness).toBeCloseTo(0.9);
  // The doc lane divides stale doc files by doc files. Both counts come from
  // the same disk walk, so the axis stays at or below 1.
  expect(dirty.components.doc_freshness).toBeCloseTo(0.25);
  expect(dirty.components.embedding_mismatch).toBeCloseTo(1);
  // …but debt is untouched by them (it has its own definition).
  expect(dirty.debt).toBe(0.1);
  expect(dirty.band).toBe("healthy");
  db.close();
});
