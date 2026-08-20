import type { Database } from "bun:sqlite";
import { statSync } from "fs";
import type { ConceptRow, LoreConfig, RegistryEntry } from "@/types/index.ts";
import { getBindingCounts, getCoverageStats, getDriftedBindings } from "@/db/concept-symbols.ts";
import { computeStateDistance } from "./residuals.ts";
import { getLastDocIndexedAt } from "@/db/chunks.ts";
import { getLastScannedAt } from "@/db/source-files.ts";
import type { DebtSnapshot } from "./debt.ts";
import { discoverFiles } from "./file-discovery.ts";
import { discoverTextFiles } from "./file-discovery-text.ts";

const WRITE_WINDOW_HOURS = 72;

export type AskDebtBand = "healthy" | "caution" | "high" | "critical";

export interface AskDebtComponents {
  symbol_drift: number;
  code_freshness: number;
  doc_freshness: number;
  coverage_gap: number;
  embedding_mismatch: number;
  active_narrative_hygiene: number;
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
  /** Expected consulted error ∈ [0,1]; null for a concept-less mind ("no
   *  concepts" is not "no debt" — retrieval runs uncalibrated there). */
  debt: number | null;
  band: AskDebtBand;
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

function toBand(debt: number | null, config: LoreConfig): AskDebtBand {
  // A mind with no concepts is unmeasured, not healthy: retrieve wide.
  if (debt == null) return "caution";
  const bands = config.thresholds.debt_bands ?? { healthy: 0.15, caution: 0.3, high: 0.5 };
  if (debt <= bands.healthy) return "healthy";
  if (debt <= bands.caution) return "caution";
  if (debt <= bands.high) return "high";
  return "critical";
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

function computeCoverageGap(db: Database, precomputed?: { ratio: number } | null): number {
  if (precomputed) return clamp01(1 - precomputed.ratio);
  try {
    const stats = getCoverageStats(db);
    if (stats.total_exported <= 0) return 0;
    return clamp01(1 - stats.bound_exported / stats.total_exported);
  } catch {
    return 0;
  }
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
    .query<{ model: string; cnt: number }, []>(
      `SELECT model, COUNT(*) as cnt FROM embeddings GROUP BY model`,
    )
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

function computeWriteActivity(
  db: Database,
  now: Date,
): { journalEntries: number; closedNarratives: number } {
  const cutoff = new Date(now.getTime() - WRITE_WINDOW_HOURS * 60 * 60 * 1000).toISOString();
  const journalEntries =
    db
      .query<{ count: number }, [string]>(
        `SELECT COUNT(*) as count
       FROM chunks
       WHERE fl_type = 'journal' AND created_at >= ?`,
      )
      .get(cutoff)?.count ?? 0;
  const closedNarratives =
    db
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
): {
  risk: number;
  openNarratives: number;
  emptyOpenNarratives: number;
  danglingNarratives: number;
} {
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
    (emptyOpenNarratives + danglingNarratives * 2) /
      Math.max(4, openNarratives + danglingNarratives * 2),
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

  // §4.3: ask keys off (debt band, coverage, freshness). Debt is the ONE debt
  // — expected consulted error, computed upstream — not a second blend. The
  // eight-weight blend this replaces produced a number no one could attribute;
  // the axes below are reported for display and diagnosis, never mixed.
  const debt = input.concepts.length === 0 ? null : input.debtSnapshot.debt;
  const band = toBand(debt, input.config);

  const symbolDrift = computeSymbolDriftRatio(input.db);
  const freshness = input.lake
    ? computeFreshnessSnapshotFromLake(input.lake)
    : computeFreshnessSnapshotFromFs(input.db, input.entry);
  const codeFreshness =
    freshness.source_files > 0 ? clamp01(freshness.stale_source_files / freshness.source_files) : 0;
  const docFreshness =
    freshness.doc_files_or_proxy > 0
      ? clamp01(freshness.stale_doc_files / freshness.doc_files_or_proxy)
      : 0;
  const coverageGap = computeCoverageGap(input.db, input.coverage);
  const embeddingMismatch = computeEmbeddingMismatchRatio(
    input.db,
    input.config,
    input.embeddingStatus,
  );
  const narrativeHygiene = computeNarrativeHygiene(input.db, input.config, now);
  const writeActivity = computeWriteActivity(input.db, now);

  let stateDistance: number | undefined;
  try {
    stateDistance = computeStateDistance(input.db, input.concepts);
  } catch {
    // Best-effort; silently skip if coverage tables not populated
  }

  return {
    debt,
    band,
    components: {
      symbol_drift: symbolDrift,
      code_freshness: codeFreshness,
      doc_freshness: docFreshness,
      coverage_gap: coverageGap,
      embedding_mismatch: embeddingMismatch,
      active_narrative_hygiene: narrativeHygiene.risk,
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
