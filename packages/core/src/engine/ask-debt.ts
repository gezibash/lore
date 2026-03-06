import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import type { ConceptRow, LoreConfig, RegistryEntry } from "@/types/index.ts";
import { getBindingCounts, getCoverageStats, getDriftedBindings } from "@/db/concept-symbols.ts";
import { computeStateDistance } from "./residuals.ts";
import { getLastDocIndexedAt } from "@/db/chunks.ts";
import { getLastScannedAt } from "@/db/source-files.ts";
import type { DebtSnapshot } from "./debt.ts";
import { conceptPressure } from "./debt.ts";
import { discoverFiles } from "./file-discovery.ts";
import { discoverTextFiles } from "./file-discovery-text.ts";

const HOT_CONCEPT_LIMIT = 20;
const WRITE_WINDOW_HOURS = 72;

const WEIGHTS = {
  staleness: 0.27,
  symbol_drift: 0.23,
  code_freshness: 0.18,
  doc_freshness: 0.08,
  coverage_gap: 0.10,
  embedding_mismatch: 0.04,
  active_narrative_hygiene: 0.05,
  priority_pressure: 0.05,
} as const;

export type AskDebtBand = "healthy" | "caution" | "high" | "critical";

export interface AskDebtComponents {
  staleness: number;
  symbol_drift: number;
  code_freshness: number;
  doc_freshness: number;
  coverage_gap: number;
  embedding_mismatch: number;
  active_narrative_hygiene: number;
  priority_pressure: number;
  write_activity_72h: {
    journal_entries: number;
    closed_narratives: number;
  };
  narrative_hygiene_72h: {
    open_narratives: number;
    empty_open_narratives: number;
    dangling_narratives: number;
  };
}

export interface AskDebtSnapshot {
  debt: number;
  confidence: number;
  band: AskDebtBand;
  base_debt: number;
  components: AskDebtComponents;
  raw_debt: number;
  raw_debt_breakdown: {
    persisted: number;
    live: number;
    display: number;
  };
  /** Formal epistemological gap between S(lore) and S(codebase) ∈ [0,1]. */
  state_distance?: number;
}

interface FreshnessSnapshot {
  stale_source_files: number;
  source_files: number;
  stale_doc_files: number;
  doc_files_or_proxy: number;
}

export interface AskDebtSnapshotInput {
  db: Database;
  entry: RegistryEntry;
  config: LoreConfig;
  concepts: ConceptRow[];
  debtSnapshot: DebtSnapshot;
  coverage?: { ratio: number } | null;
  lake?: {
    stale_source_files: number;
    source_files: number;
    stale_doc_files: number;
    doc_chunks: number;
  } | null;
  embeddingStatus?: { total: number; stale: number } | null;
  now?: Date;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clamp100(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function toBand(debt: number): AskDebtBand {
  if (debt <= 25) return "healthy";
  if (debt <= 50) return "caution";
  if (debt <= 75) return "high";
  return "critical";
}

function weightedAverage(values: Array<{ value: number; weight: number }>): number {
  if (values.length === 0) return 0;
  const sumWeight = values.reduce((sum, item) => sum + item.weight, 0);
  if (sumWeight <= 1e-9) {
    const mean = values.reduce((sum, item) => sum + item.value, 0) / values.length;
    return clamp01(mean);
  }
  const mean = values.reduce((sum, item) => sum + item.value * item.weight, 0) / sumWeight;
  return clamp01(mean);
}

function computeHotStaleness(
  concepts: ConceptRow[],
  refDriftScoreByConcept: Map<string, number>,
): number {
  if (concepts.length === 0) return 0;
  const top = [...concepts]
    .sort((a, b) => conceptPressure(b, refDriftScoreByConcept) - conceptPressure(a, refDriftScoreByConcept))
    .slice(0, HOT_CONCEPT_LIMIT);
  const weighted = top.map((concept) => ({
    value: concept.staleness ?? 0,
    weight: Math.max(0.001, conceptPressure(concept, refDriftScoreByConcept)),
  }));
  return weightedAverage(weighted);
}

function computeSymbolDriftRatio(db: Database): number {
  try {
    const drifted = getDriftedBindings(db).length;
    const counts = getBindingCounts(db);
    if (counts.total <= 0) return 0;
    return clamp01(drifted / counts.total);
  } catch {
    return 0;
  }
}

function computeCoverageGap(
  db: Database,
  precomputed?: { ratio: number } | null,
): number {
  if (precomputed) return clamp01(1 - precomputed.ratio);
  try {
    const stats = getCoverageStats(db);
    if (stats.total_exported <= 0) return 0;
    return clamp01(1 - stats.bound_exported / stats.total_exported);
  } catch {
    return 0;
  }
}

function computePriorityPressure(
  concepts: ConceptRow[],
  refDriftScoreByConcept: Map<string, number>,
): number {
  if (concepts.length === 0) return 0;
  const pressures = concepts
    .map((concept) => conceptPressure(concept, refDriftScoreByConcept))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a);
  if (pressures.length === 0) return 0;

  const topCount = Math.min(5, pressures.length);
  const topMean = pressures.slice(0, topCount).reduce((sum, value) => sum + value, 0) / topCount;
  const overallMean = pressures.reduce((sum, value) => sum + value, 0) / pressures.length;
  const hotRatio = pressures.filter((value) => value >= 0.4).length / pressures.length;
  const skew = overallMean > 0
    ? clamp01((topMean - overallMean) / Math.max(0.1, 1 - overallMean))
    : clamp01(topMean);

  return clamp01(topMean * 0.65 + hotRatio * 0.2 + skew * 0.15);
}

function computeEmbeddingMismatchRatio(
  db: Database,
  config: LoreConfig,
  precomputed?: { total: number; stale: number } | null,
): number {
  if (precomputed) {
    if (precomputed.total <= 0) return 0;
    return clamp01(precomputed.stale / precomputed.total);
  }

  const rows = db
    .query<{ model: string; cnt: number }, []>(`SELECT model, COUNT(*) as cnt FROM embeddings GROUP BY model`)
    .all();
  const total = rows.reduce((sum, row) => sum + row.cnt, 0);
  if (total <= 0) return 0;
  const currentModel = config.ai.embedding.model;
  const currentCodeModel = config.ai.embedding.code?.model ?? null;
  const validModels = new Set([currentModel, ...(currentCodeModel ? [currentCodeModel] : [])]);
  const matching = rows
    .filter((row) => validModels.has(row.model))
    .reduce((sum, row) => sum + row.cnt, 0);
  const stale = total - matching;
  return clamp01(stale / total);
}

function computeFreshnessSnapshotFromLake(
  lake: NonNullable<AskDebtSnapshotInput["lake"]>,
): FreshnessSnapshot {
  return {
    stale_source_files: lake.stale_source_files,
    source_files: lake.source_files,
    stale_doc_files: lake.stale_doc_files,
    doc_files_or_proxy: Math.max(1, lake.doc_chunks),
  };
}

function computeFreshnessSnapshotFromFs(db: Database, entry: RegistryEntry): FreshnessSnapshot {
  let staleSourceFiles = 0;
  let sourceFiles = 0;
  let staleDocFiles = 0;
  let docFiles = 0;

  try {
    const source = discoverFiles(entry.code_path);
    sourceFiles = source.length;
    const lastCodeScan = getLastScannedAt(db);
    const lastCodeMs = lastCodeScan ? new Date(lastCodeScan).getTime() : 0;
    for (const file of source) {
      try {
        if (statSync(file.absolutePath).mtimeMs > lastCodeMs) staleSourceFiles++;
      } catch {
        // File may have been deleted while scanning.
      }
    }
  } catch {
    // Best-effort metric only.
  }

  try {
    const docs = discoverTextFiles(entry.code_path, entry.lore_path);
    docFiles = docs.length;
    const lastDocIngest = getLastDocIndexedAt(db);
    const lastDocMs = lastDocIngest ? new Date(lastDocIngest).getTime() : 0;
    for (const file of docs) {
      try {
        if (statSync(file.absolutePath).mtimeMs > lastDocMs) staleDocFiles++;
      } catch {
        // File may have been deleted while scanning.
      }
    }
  } catch {
    // Best-effort metric only.
  }

  return {
    stale_source_files: staleSourceFiles,
    source_files: sourceFiles,
    stale_doc_files: staleDocFiles,
    doc_files_or_proxy: Math.max(1, docFiles),
  };
}

function computeWriteActivity(db: Database, now: Date): { journalEntries: number; closedNarratives: number } {
  const cutoff = new Date(now.getTime() - WRITE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const journalEntries = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count
       FROM chunks
       WHERE fl_type = 'journal' AND created_at >= ?`,
    )
    .get(cutoff)?.count ?? 0;
  const closedNarratives = db
    .query<{ count: number }, [string]>(
      `SELECT COUNT(*) as count
       FROM narratives
       WHERE status = 'closed' AND closed_at IS NOT NULL AND closed_at >= ?`,
    )
    .get(cutoff)?.count ?? 0;
  return { journalEntries, closedNarratives };
}

function computeNarrativeHygiene(
  db: Database,
  config: LoreConfig,
  now: Date,
): { risk: number; openNarratives: number; emptyOpenNarratives: number; danglingNarratives: number } {
  let rows: Array<{ entry_count: number; opened_at: string }> = [];
  try {
    rows = db
      .query<{ entry_count: number; opened_at: string }, []>(
        `SELECT entry_count, opened_at
         FROM current_narratives
         WHERE status IN ('open', 'close_failed')`,
      )
      .all();
  } catch {
    return { risk: 0, openNarratives: 0, emptyOpenNarratives: 0, danglingNarratives: 0 };
  }

  if (rows.length === 0) {
    return { risk: 0, openNarratives: 0, emptyOpenNarratives: 0, danglingNarratives: 0 };
  }

  const openNarratives = rows.length;
  const emptyOpenNarratives = rows.filter((row) => row.entry_count <= 0).length;
  const danglingMs = config.thresholds.dangling_days * 24 * 60 * 60 * 1000;
  const nowMs = now.getTime();
  let danglingNarratives = 0;
  for (const row of rows) {
    const openedMs = new Date(row.opened_at).getTime();
    if (!Number.isFinite(openedMs)) continue;
    if (nowMs - openedMs > danglingMs) danglingNarratives++;
  }

  const risk = clamp01(
    (emptyOpenNarratives + danglingNarratives * 2) / Math.max(4, openNarratives + danglingNarratives * 2),
  );
  return { risk, openNarratives, emptyOpenNarratives, danglingNarratives };
}

export function askDebtRetrievalMultiplier(band: AskDebtBand): number {
  if (band === "healthy") return 1.0;
  if (band === "caution") return 1.2;
  if (band === "high") return 1.4;
  return 1.6;
}

export function askDebtStalenessPenaltyMultiplier(band: AskDebtBand): number {
  if (band === "healthy") return 1.0;
  if (band === "caution") return 1.15;
  if (band === "high") return 1.25;
  return 1.5;
}

export function askDebtBandWarning(band: AskDebtBand): string | undefined {
  if (band === "high") {
    return "ask debt is high — verify key claims against code";
  }
  if (band === "critical") {
    return "ask debt is critical — verify all critical claims against code";
  }
  return undefined;
}

export function computeAskDebtSnapshot(input: AskDebtSnapshotInput): AskDebtSnapshot {
  const now = input.now ?? new Date();
  const staleness = computeHotStaleness(input.concepts, input.debtSnapshot.refDriftScoreByConcept);
  const symbolDrift = computeSymbolDriftRatio(input.db);

  const freshness = input.lake
    ? computeFreshnessSnapshotFromLake(input.lake)
    : computeFreshnessSnapshotFromFs(input.db, input.entry);
  const codeFreshness = freshness.source_files > 0
    ? clamp01(freshness.stale_source_files / freshness.source_files)
    : 0;
  const docFreshness = freshness.doc_files_or_proxy > 0
    ? clamp01(freshness.stale_doc_files / freshness.doc_files_or_proxy)
    : 0;

  const coverageGap = computeCoverageGap(input.db, input.coverage);
  const embeddingMismatch = computeEmbeddingMismatchRatio(
    input.db,
    input.config,
    input.embeddingStatus,
  );
  const priorityPressure = computePriorityPressure(
    input.concepts,
    input.debtSnapshot.refDriftScoreByConcept,
  );
  const narrativeHygiene = computeNarrativeHygiene(input.db, input.config, now);
  const writeActivity = computeWriteActivity(input.db, now);

  const baseDebt = 100 * (
    WEIGHTS.staleness * staleness +
    WEIGHTS.symbol_drift * symbolDrift +
    WEIGHTS.code_freshness * codeFreshness +
    WEIGHTS.doc_freshness * docFreshness +
    WEIGHTS.coverage_gap * coverageGap +
    WEIGHTS.embedding_mismatch * embeddingMismatch +
    WEIGHTS.active_narrative_hygiene * narrativeHygiene.risk +
    WEIGHTS.priority_pressure * priorityPressure
  );

  const debt = clamp100(baseDebt);
  const confidence = clamp100(100 - debt);
  const band = toBand(debt);

  let stateDistance: number | undefined;
  try {
    stateDistance = computeStateDistance(input.db, input.concepts);
  } catch {
    // Best-effort; silently skip if coverage tables not populated
  }

  return {
    debt,
    confidence,
    band,
    base_debt: baseDebt,
    components: {
      staleness,
      symbol_drift: symbolDrift,
      code_freshness: codeFreshness,
      doc_freshness: docFreshness,
      coverage_gap: coverageGap,
      embedding_mismatch: embeddingMismatch,
      active_narrative_hygiene: narrativeHygiene.risk,
      priority_pressure: priorityPressure,
      write_activity_72h: {
        journal_entries: writeActivity.journalEntries,
        closed_narratives: writeActivity.closedNarratives,
      },
      narrative_hygiene_72h: {
        open_narratives: narrativeHygiene.openNarratives,
        empty_open_narratives: narrativeHygiene.emptyOpenNarratives,
        dangling_narratives: narrativeHygiene.danglingNarratives,
      },
    },
    raw_debt: input.debtSnapshot.debt,
    raw_debt_breakdown: {
      persisted: input.debtSnapshot.persisted_debt,
      live: input.debtSnapshot.live_debt,
      display: input.debtSnapshot.debt,
    },
    state_distance: stateDistance,
  };
}
