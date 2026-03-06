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
    symbolDriftWarnings: new Map(),
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

test("computeAskDebtSnapshot returns healthy debt when freshness and coverage are clean", () => {
  const db = createTestDb();
  const snapshot = computeAskDebtSnapshot({
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [],
    debtSnapshot: makeDebtSnapshot(),
    coverage: { ratio: 1 },
    lake: {
      stale_source_files: 0,
      source_files: 10,
      stale_doc_files: 0,
      doc_chunks: 10,
    },
    embeddingStatus: { total: 10, stale: 0 },
    now: new Date("2026-03-03T00:00:00.000Z"),
  });

  expect(snapshot.debt).toBe(0);
  expect(snapshot.confidence).toBe(100);
  expect(snapshot.band).toBe("healthy");
  expect(snapshot.base_debt).toBe(0);
  expect(snapshot.raw_debt).toBe(0);

  db.close();
});

test("computeAskDebtSnapshot keeps debt signal independent from write activity", () => {
  const db = createTestDb();
  const entry = makeEntry();
  const concept = makeConcept();
  const debtSnapshot = makeDebtSnapshot({
    debt: 2.5,
    persisted_debt: 2.2,
    live_debt: 2.5,
    refDriftScoreByConcept: new Map([[concept.id, 0]]),
  });

  const sharedInput = {
    db,
    entry,
    config: defaultConfig,
    concepts: [concept],
    debtSnapshot,
    coverage: { ratio: 0 },
    lake: {
      stale_source_files: 10,
      source_files: 10,
      stale_doc_files: 10,
      doc_chunks: 10,
    },
    embeddingStatus: { total: 10, stale: 10 },
  };

  const baseline = computeAskDebtSnapshot({
    ...sharedInput,
    now: new Date("2026-03-03T00:00:00.000Z"),
  });

  const nowIso = new Date("2026-03-03T00:30:00.000Z").toISOString();
  for (let i = 0; i < 20; i++) {
    insertChunk(db, {
      id: `j-${i}`,
      filePath: `.lore/chunks/j-${i}.md`,
      flType: "journal",
      createdAt: nowIso,
    });
  }
  for (let i = 0; i < 5; i++) {
    const narrative = insertNarrative(db, `narrative-${i}`, "test");
    closeNarrative(db, narrative.id);
  }

  const withWrites = computeAskDebtSnapshot({
    ...sharedInput,
    now: new Date("2026-03-03T01:00:00.000Z"),
  });

  expect(withWrites.components.write_activity_72h.journal_entries).toBe(20);
  expect(withWrites.components.write_activity_72h.closed_narratives).toBe(5);
  expect(withWrites.debt).toBeCloseTo(baseline.debt, 8);
  expect(withWrites.base_debt).toBeCloseTo(baseline.base_debt, 8);

  db.close();
});

test("computeAskDebtSnapshot penalizes empty active narratives", () => {
  const db = createTestDb();
  const input = {
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [] as ConceptRow[],
    debtSnapshot: makeDebtSnapshot(),
    coverage: { ratio: 1 },
    lake: {
      stale_source_files: 0,
      source_files: 10,
      stale_doc_files: 0,
      doc_chunks: 10,
    },
    embeddingStatus: { total: 10, stale: 0 },
    now: new Date("2026-03-03T00:00:00.000Z"),
  };

  const baseline = computeAskDebtSnapshot(input);
  expect(baseline.debt).toBe(0);

  insertNarrative(db, "open-a", "a");
  insertNarrative(db, "open-b", "b");
  insertNarrative(db, "open-c", "c");

  const withEmptyNarratives = computeAskDebtSnapshot(input);
  expect(withEmptyNarratives.debt).toBeGreaterThan(0);
  expect(withEmptyNarratives.components.active_narrative_hygiene).toBeGreaterThan(0);
  expect(withEmptyNarratives.components.narrative_hygiene_72h.open_narratives).toBe(3);
  expect(withEmptyNarratives.components.narrative_hygiene_72h.empty_open_narratives).toBe(3);
  expect(withEmptyNarratives.components.narrative_hygiene_72h.dangling_narratives).toBe(0);

  db.close();
});

test("computeAskDebtSnapshot includes priority pressure when top concepts dominate", () => {
  const db = createTestDb();
  const top = makeConcept({
    id: "c-top",
    name: "top",
    staleness: 0,
    residual: 1,
    churn: 1,
    ground_residual: 1,
    lore_residual: 1,
  });
  const peers = [1, 2, 3, 4].map((i) =>
    makeConcept({
      id: `c-${i}`,
      name: `c-${i}`,
      staleness: 0,
      residual: 0.05,
      churn: 0.05,
      ground_residual: 0.05,
      lore_residual: 0.05,
    }));

  const snapshot = computeAskDebtSnapshot({
    db,
    entry: makeEntry(),
    config: defaultConfig,
    concepts: [top, ...peers],
    debtSnapshot: makeDebtSnapshot(),
    coverage: { ratio: 1 },
    lake: {
      stale_source_files: 0,
      source_files: 10,
      stale_doc_files: 0,
      doc_chunks: 10,
    },
    embeddingStatus: { total: 10, stale: 0 },
    now: new Date("2026-03-03T00:00:00.000Z"),
  });

  expect(snapshot.components.priority_pressure).toBeGreaterThan(0);
  expect(snapshot.debt).toBeGreaterThan(0);

  db.close();
});
