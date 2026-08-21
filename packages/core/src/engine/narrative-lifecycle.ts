import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import { timeAgo } from "@/format.ts";
import {
  LoreError,
  type LoreConfig,
  type ReasoningLevel,
  type OpenResult,
  type LogResult,
  type QueryResult,
  type ExecutiveSummary,
  type JournalTrailEntry,
  type JournalTrailGroup,
  type CloseResult,
  type PhaseTransitionWarning,
  type MergeConflict,
  type MergeStrategy,
  type ResolveDangling,
  type NarrativeTarget,
  type NarrativeRow,
  type SymbolDriftResult,
  type ConceptBindingSummary,
  type ConceptRelationRow,
  type ConceptRow,
  type ChunkRow,
} from "@/types/index.ts";
import {
  insertNarrative,
  getNarrativeByName,
  getNarrativeByNameWithStatuses,
  getActiveNarratives,
  getDanglingNarratives,
  reopenNarrative,
  closeNarrative as closeDbNarrative,
  abandonNarrative as abandonDbNarrative,
  updateNarrativeMetrics,
  getConcepts,
  getActiveConcepts,
  getActiveConceptByName,
  getManifest,
  upsertManifest,
  insertChunk,
  insertChunkBatch,
  insertEmbeddingBatch,
  insertFtsContent,
  insertFtsContentBatch,
  insertSnapshot,
  getEmbeddingForChunk,
  getChunkCount,
  getActiveConceptCount,
  getLatestDebt,
  getHeadCommit,
  getCommitTreeAsMap,
  insertCommit,
  insertCommitTree,
  getChunk,
  getChunksForConcept,
  getConcept,
  getNarrative,
  getJournalChunksForNarrative,
  getJournalTopicsForNarrative,
  getFilesForConcept,
  insertSymbolEmbeddingBatch,
  queueCloseMaintenanceJob,
  getCloseMaintenanceJobCounts,
} from "@/db/index.ts";
import {
  insertConceptVersion,
  insertConceptRaw,
  insertConceptVersionBatch,
  insertConceptRawBatch,
  getConceptByName,
  getConceptsByCluster,
} from "@/db/concepts.ts";
import {
  writeStateChunk,
  writeJournalChunk,
  updateChunkFrontmatter,
  writeEmbeddingFile,
  embeddingFilePath,
} from "@/storage/index.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { hybridSearch } from "./search.ts";
import type { HybridSearchResult } from "./search.ts";
import { webSearch } from "./web-search.ts";
import { cosineDistance, averageVectors, weightedAverageVectors } from "./residuals.ts";
import { discoverConcepts } from "./concept-discovery.ts";
import { buildExplicitClosePlan } from "./close-planner.ts";
import {
  computeDebtTrend,
  recordResiduals,
  computeStaleness,
} from "./residuals.ts";
import {
  computeExpectedDebt,
  getConceptBindingStats,
  groundednessResidual,
  stalenessSigma,
  type GroundednessResult,
} from "./measurement.ts";
import { readSymbolContent } from "./git.ts";
import {
  getDriftedBindings,
  getBindingSummariesForConcept,
  getCoverageStats,
  upsertConceptSymbol,
} from "@/db/concept-symbols.ts";
import type { ConceptSymbolLineRange } from "@/db/concept-symbols.ts";
import { getConceptRelations, get2HopNeighbors } from "@/db/concept-relations.ts";
import { rescanFiles } from "./scanner.ts";
import {
  extractBindingsForConcepts,
  pruneOrphanedBindings,
  autoBindByFileOverlap,
} from "./binding-extraction.ts";
import type { FileRef, SymbolSearchResult } from "@/types/index.ts";
import type { Embedder } from "./embedder.ts";
import type { Generator } from "./generator.ts";
import { rerankResults } from "./reranker.ts";
import { tracer } from "./tracer.ts";
import type { AskTracer } from "./tracer.ts";
import { markLanceDirty } from "./lance-index.ts";
import { isTestFilePath } from "./search.ts";
import { expandCamelCase } from "@/db/symbols.ts";
import { computeLineDiff, isDiffTooLarge } from "./line-diff.ts";
import { searchSymbols, getSymbolByQualifiedName } from "@/db/symbols.ts";
import { getConceptsForSymbols } from "@/db/concept-symbols.ts";
import { getCallSitesForCallee, getCallSitesByCaller } from "@/db/call-sites.ts";
import { enrichSymbolResults } from "./symbol-search.ts";

function isNarrativeWritable(status: NarrativeRow["status"]): boolean {
  return status === "open" || status === "close_failed";
}

function isNarrativeClosable(status: NarrativeRow["status"]): boolean {
  return status === "open" || status === "closing" || status === "close_failed";
}
import {
  askDebtBandWarning,
  askDebtRetrievalMultiplier,
  askDebtStalenessPenaltyMultiplier,
  type AskDebtBand,
} from "./ask-debt.ts";
import { mapConcurrent } from "./async.ts";
import { resolveJournalConceptDesignations } from "./journal-routing.ts";

/**
 * Create a genesis commit that snapshots the current concept→chunk state.
 * Used when no commits exist yet (first narrative open, or after rebuild).
 */
export function createGenesisCommit(db: Database): ReturnType<typeof insertCommit> {
  const concepts = getConcepts(db);
  const treeEntries: Array<{ conceptId: string; chunkId: string; conceptName: string }> = [];
  for (const c of concepts) {
    if (c.active_chunk_id && (c.lifecycle_status == null || c.lifecycle_status === "active")) {
      treeEntries.push({ conceptId: c.id, chunkId: c.active_chunk_id, conceptName: c.name });
    }
  }
  const commit = insertCommit(db, null, null, null, "genesis: initial state snapshot");
  insertCommitTree(db, commit.id, treeEntries);
  return commit;
}

function batchLoadChunksByIds(db: Database, chunkIds: readonly string[]): Map<string, ChunkRow> {
  if (chunkIds.length === 0) return new Map();
  const placeholders = chunkIds.map(() => "?").join(", ");
  const rows = db
    .query<ChunkRow, string[]>(`SELECT * FROM chunks WHERE id IN (${placeholders})`)
    .all(...chunkIds);
  return new Map(rows.map((row) => [row.id, row]));
}

type ParsedChunk = Awaited<ReturnType<typeof readChunk>>;

async function batchReadParsedChunksByIds(
  chunkRowsById: Map<string, ChunkRow>,
  chunkIds: readonly (string | null | undefined)[],
  concurrency = 8,
): Promise<Map<string, ParsedChunk>> {
  const uniqueChunkIds = [
    ...new Set(chunkIds.filter((chunkId): chunkId is string => !!chunkId)),
  ].filter((chunkId) => chunkRowsById.has(chunkId));
  if (uniqueChunkIds.length === 0) return new Map();

  const parsed = await mapConcurrent(uniqueChunkIds, concurrency, async (chunkId) => ({
    chunkId,
    parsed: await readChunk(chunkRowsById.get(chunkId)!.file_path),
  }));
  return new Map(parsed.map((entry) => [entry.chunkId, entry.parsed]));
}

function batchLoadEmbeddingsByChunkIds(
  db: Database,
  chunkIds: readonly (string | null | undefined)[],
): Map<string, Float32Array> {
  const uniqueChunkIds = [...new Set(chunkIds.filter((chunkId): chunkId is string => !!chunkId))];
  if (uniqueChunkIds.length === 0) return new Map();
  const placeholders = uniqueChunkIds.map(() => "?").join(", ");
  const rows = db
    .query<{ chunk_id: string; embedding: Uint8Array }, string[]>(
      `SELECT chunk_id, embedding FROM embeddings WHERE chunk_id IN (${placeholders})`,
    )
    .all(...uniqueChunkIds);
  return new Map(rows.map((row) => [row.chunk_id, new Float32Array(row.embedding.buffer)]));
}

function batchLoadSymbolBodyHashesByIds(
  db: Database,
  symbolIds: readonly string[],
): Map<string, string | null> {
  if (symbolIds.length === 0) return new Map();
  const placeholders = symbolIds.map(() => "?").join(", ");
  const rows = db
    .query<{ id: string; body_hash: string | null }, string[]>(
      `SELECT id, body_hash FROM symbols WHERE id IN (${placeholders})`,
    )
    .all(...symbolIds);
  return new Map(rows.map((row) => [row.id, row.body_hash]));
}

function mergeFrontmatterUpdates(
  updatesByPath: Map<string, Record<string, unknown>>,
  filePath: string,
  updates: Record<string, unknown>,
): void {
  const current = updatesByPath.get(filePath) ?? {};
  updatesByPath.set(filePath, { ...current, ...updates });
}

function batchLoadConceptsByIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, ConceptRow> {
  if (conceptIds.length === 0) return new Map();
  const placeholders = conceptIds.map(() => "?").join(", ");
  const rows = db
    .query<ConceptRow, string[]>(`SELECT * FROM current_concepts WHERE id IN (${placeholders})`)
    .all(...conceptIds);
  return new Map(rows.map((row) => [row.id, row]));
}

function batchLoadBindingSummariesByConceptIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, ConceptBindingSummary[]> {
  const grouped = new Map<string, ConceptBindingSummary[]>();
  if (conceptIds.length === 0) return grouped;

  let rows: Array<ConceptBindingSummary & { concept_id: string }> = [];
  try {
    const placeholders = conceptIds.map(() => "?").join(", ");
    rows = db
      .query<ConceptBindingSummary & { concept_id: string }, string[]>(
        `SELECT cs.concept_id, s.name AS symbol_name, s.qualified_name AS symbol_qualified_name,
                s.kind AS symbol_kind, sf.file_path, s.line_start,
                cs.binding_type, cs.confidence
         FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id IN (${placeholders})
         ORDER BY cs.concept_id, sf.file_path, s.line_start`,
      )
      .all(...conceptIds);
  } catch {
    return grouped;
  }

  for (const row of rows) {
    const list = grouped.get(row.concept_id);
    const summary: ConceptBindingSummary = {
      symbol_name: row.symbol_name,
      symbol_qualified_name: row.symbol_qualified_name,
      symbol_kind: row.symbol_kind,
      file_path: row.file_path,
      line_start: row.line_start,
      binding_type: row.binding_type,
      confidence: row.confidence,
    };
    if (list) list.push(summary);
    else grouped.set(row.concept_id, [summary]);
  }

  return grouped;
}

function batchLoadFilesByConceptIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, string[]> {
  const grouped = new Map<string, string[]>();
  if (conceptIds.length === 0) return grouped;

  let rows: Array<{ concept_id: string; file_path: string }> = [];
  try {
    const placeholders = conceptIds.map(() => "?").join(", ");
    rows = db
      .query<{ concept_id: string; file_path: string }, string[]>(
        `SELECT DISTINCT cs.concept_id, sf.file_path
         FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id IN (${placeholders})
         ORDER BY cs.concept_id, sf.file_path`,
      )
      .all(...conceptIds);
  } catch {
    return grouped;
  }

  for (const row of rows) {
    const list = grouped.get(row.concept_id);
    if (list) list.push(row.file_path);
    else grouped.set(row.concept_id, [row.file_path]);
  }

  return grouped;
}

function batchLoadLastNarrativesByConceptIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, { name: string; intent: string; closed_at: string }> {
  const grouped = new Map<string, { name: string; intent: string; closed_at: string }>();
  if (conceptIds.length === 0) return grouped;

  let rows: Array<{ concept_id: string; name: string; intent: string; closed_at: string }> = [];
  try {
    const placeholders = conceptIds.map(() => "?").join(", ");
    rows = db
      .query<{ concept_id: string; name: string; intent: string; closed_at: string }, string[]>(
        `SELECT c.concept_id, d.name, d.intent, d.closed_at
         FROM chunks c
         JOIN current_narratives d ON d.id = c.narrative_id
         WHERE c.concept_id IN (${placeholders})
           AND c.fl_type = 'chunk'
           AND d.status = 'closed'
           AND d.closed_at IS NOT NULL
         ORDER BY c.concept_id, c.created_at DESC`,
      )
      .all(...conceptIds);
  } catch {
    return grouped;
  }

  for (const row of rows) {
    if (!grouped.has(row.concept_id)) {
      grouped.set(row.concept_id, {
        name: row.name,
        intent: row.intent,
        closed_at: row.closed_at,
      });
    }
  }

  return grouped;
}

function batchLoadSymbolLinesByConceptIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, ConceptSymbolLineRange[]> {
  const grouped = new Map<string, ConceptSymbolLineRange[]>();
  if (conceptIds.length === 0) return grouped;

  let rows: Array<ConceptSymbolLineRange & { concept_id: string }> = [];
  try {
    const placeholders = conceptIds.map(() => "?").join(", ");
    rows = db
      .query<ConceptSymbolLineRange & { concept_id: string }, string[]>(
        `SELECT cs.concept_id, cs.symbol_id, sf.file_path, s.name AS symbol_name, s.qualified_name, s.kind,
                s.line_start, s.line_end, s.signature, cs.confidence
         FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id IN (${placeholders})
         ORDER BY cs.concept_id, sf.file_path, s.line_start`,
      )
      .all(...conceptIds);
  } catch {
    return grouped;
  }

  for (const row of rows) {
    const list = grouped.get(row.concept_id);
    const lineRange: ConceptSymbolLineRange = {
      symbol_id: row.symbol_id,
      file_path: row.file_path,
      symbol_name: row.symbol_name,
      qualified_name: row.qualified_name,
      kind: row.kind,
      line_start: row.line_start,
      line_end: row.line_end,
      signature: row.signature,
      confidence: row.confidence,
    };
    if (list) list.push(lineRange);
    else grouped.set(row.concept_id, [lineRange]);
  }

  return grouped;
}

export async function openNarrative(
  db: Database,
  lorePath: string,
  narrativeName: string,
  intent: string,
  config: LoreConfig,
  embedder: Embedder,
  resolveDangling?: ResolveDangling | ResolveDangling[],
  targets?: NarrativeTarget[],
): Promise<OpenResult> {
  const existing = getNarrativeByName(db, narrativeName);
  if (
    existing &&
    (existing.status === "open" ||
      existing.status === "closing" ||
      existing.status === "close_failed")
  ) {
    throw new LoreError(
      "NARRATIVE_ALREADY_OPEN",
      `Narrative '${narrativeName}' is already ${existing.status}`,
    );
  }

  // Check for dangling narratives
  const dangling = getDanglingNarratives(db, config.thresholds.dangling_days);
  if (dangling.length > 0 && !resolveDangling) {
    const described = dangling.map((d) => ({
      name: d.name,
      age_days: Math.floor(
        (Date.now() - new Date(d.opened_at).getTime()) / (24 * 60 * 60 * 1000),
      ),
    }));
    // Name them and state the remedy in the message: details ride on the error
    // object but no surface renders them, so the bare "dangling detected" left
    // the user to go find the names themselves before they could proceed.
    const list = described.map((d) => `${d.name} (${d.age_days}d)`).join(", ");
    throw new LoreError(
      "DANGLING_NARRATIVE",
      `Dangling narrative(s) detected: ${list}. Resolve each with --resolve <name>:resume|abandon, or close them first.`,
      { narratives: described },
    );
  }

  // Handle dangling resolution. A mind can have several dangling narratives, so
  // this accepts a list — resolving them one per invocation was impossible when
  // any unresolved one blocks the open.
  for (const resolution of resolveDangling
    ? Array.isArray(resolveDangling)
      ? resolveDangling
      : [resolveDangling]
    : []) {
    const danglingNarrative = getNarrativeByNameWithStatuses(db, resolution.narrative, [
      "open",
      "close_failed",
    ]);
    if (!danglingNarrative) continue;
    switch (resolution.action) {
      case "abandon":
        abandonDbNarrative(db, danglingNarrative.id);
        break;
      case "resume":
        if (danglingNarrative.status === "close_failed") {
          reopenNarrative(db, danglingNarrative.id);
        }
        // Return context for the existing narrative instead
        return buildOpenResult(db, config, embedder, intent);
      default:
        throw new LoreError(
          "DANGLING_NARRATIVE",
          `Unsupported dangling narrative action '${String(resolution.action)}'`,
        );
    }
  }

  // Validate declared targets
  if (targets && targets.length > 0) {
    for (const target of targets) {
      if (target.op === "create") {
        // create: concept name must not already be active
        const existing = getActiveConceptByName(db, target.concept);
        if (existing) {
          throw new LoreError(
            "CONCEPT_NAME_CONFLICT",
            `Target concept '${target.concept}' already exists (op: create). Use 'update' to update an existing concept.`,
          );
        }
      } else if (target.op === "rename") {
        const existing = getActiveConceptByName(db, target.from);
        if (!existing) {
          throw new LoreError(
            "CONCEPT_NOT_FOUND",
            `Target concept '${target.from}' not found (op: rename).`,
          );
        }
      } else if (target.op === "merge") {
        const existing = getActiveConceptByName(db, target.source);
        if (!existing) {
          throw new LoreError(
            "CONCEPT_NOT_FOUND",
            `Target concept '${target.source}' not found (op: merge).`,
          );
        }
      } else {
        // update, archive, restore, split: concept name is in target.concept
        const existing = getActiveConceptByName(db, target.concept);
        if (!existing) {
          throw new LoreError(
            "CONCEPT_NOT_FOUND",
            `Target concept '${target.concept}' not found (op: ${target.op}).`,
          );
        }
      }
    }
  }

  // Record merge base: HEAD commit at time of open
  let head = getHeadCommit(db);
  if (!head) {
    head = createGenesisCommit(db);
  }

  // Create new narrative with merge base and declared targets
  const narrative = insertNarrative(db, narrativeName, intent, head.id, targets);

  // Snapshot current concepts
  const concepts = getConcepts(db);
  for (const concept of concepts) {
    if (concept.active_chunk_id) {
      const emb = getEmbeddingForChunk(db, concept.active_chunk_id);
      if (emb) {
        insertSnapshot(db, concept.id, narrative.id, emb.id);
      }
    }
  }

  return buildOpenResult(db, config, embedder, intent);
}

async function buildOpenResult(
  db: Database,
  config: LoreConfig,
  embedder: Embedder,
  intent: string,
): Promise<OpenResult> {
  // Search for relevant context based on intent. Best-effort: an unreachable
  // embedder must not block opening a narrative — the agent just starts blind.
  let results: Awaited<ReturnType<typeof hybridSearch>>["results"] = [];
  try {
    ({ results } = await hybridSearch(db, embedder, intent, config, {
      sourceType: "chunk",
      limit: 5,
      textModel: config.ai.embedding.model,
    }));
  } catch {
    // context surfacing skipped
  }

  const readNow = results.map((r) => ({
    file: r.concept ?? "unknown",
    summary: r.content.slice(0, 200),
    priority: (r.score > 0.3 ? "high" : "medium") as "high" | "medium" | "low",
    warning: r.warning,
  }));

  // Check for overlapping narratives
  const headsUp: string[] = [];
  const activeNarratives = getActiveNarratives(db);
  for (const narrative of activeNarratives) {
    headsUp.push(
      `Narrative '${narrative.name}' is currently ${narrative.status} (opened ${timeAgo(narrative.opened_at)})`,
    );
  }

  return { context: { read_now: readNow, heads_up: headsUp } };
}

/**
 * Infer journal entry status from text using simple heuristics.
 * Replaces the LLM-based inferStatus call — status is only used
 * for the advisory note, never consumed downstream.
 */
function inferStatusHeuristic(text: string): "finding" | "dead-end" | "confirmed" | "question" {
  if (/\b(dead[ -]end|failed|abandoned|doesn't work|gave up)\b/i.test(text)) return "dead-end";
  if (/\?\s*$/.test(text.trim())) return "question";
  if (/\b(confirmed|verified|validated)\b/i.test(text)) return "confirmed";
  return "finding";
}


export interface LogEntryOpts {
  topics?: string[];
  codePath?: string;
  refs?: FileRef[];
  concepts?: string[];
  symbols?: string[];
}

export async function logEntry(
  db: Database,
  lorePath: string,
  narrativeName: string,
  text: string,
  config: LoreConfig,
  opts: LogEntryOpts = {},
): Promise<LogResult> {
  const { topics = [], refs, concepts, symbols } = opts;
  const current = getNarrativeByName(db, narrativeName);
  if (!current) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }
  if (current.status === "closing") {
    throw new LoreError(
      "NARRATIVE_CLOSING",
      `Narrative '${narrativeName}' is currently closing and cannot accept new entries`,
    );
  }
  if (!isNarrativeWritable(current.status)) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }
  if (current.status === "close_failed") {
    reopenNarrative(db, current.id);
  }
  const narrative = getNarrative(db, current.id);
  if (!narrative) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }

  // Get previous journal entry for this narrative
  const prevChunks = db
    .query<{ id: string }, [string]>(
      `SELECT id FROM chunks WHERE narrative_id = ? AND fl_type = 'journal' ORDER BY created_at DESC LIMIT 1`,
    )
    .get(narrative.id);

  // Status: simple heuristic (only used for advisory note)
  const status = inferStatusHeuristic(text);

  const { designations: conceptDesignations, conceptRefs: resolvedConceptIds } =
    resolveJournalConceptDesignations(db, narrative, concepts);

  // Resolve symbol names → IDs
  const resolvedSymbolIds: string[] = [];
  if (symbols && symbols.length > 0) {
    for (const name of symbols) {
      // Exact qualified name lookup first
      const sym = getSymbolByQualifiedName(db, name);
      if (sym) {
        resolvedSymbolIds.push(sym.id);
      } else {
        // FTS fallback
        const results = searchSymbols(db, name, { limit: 1 });
        if (results.length > 0) {
          resolvedSymbolIds.push(results[0]!.symbol_id);
        }
        // Unresolved names silently skipped
      }
    }
  }

  // Auto-derive topics from concept names if concepts provided but topics empty
  const effectiveTopics = topics.length === 0 ? [...conceptDesignations] : topics;

  // Embedding deferred to close time (batch embed) — log is pure I/O + DB

  // Write journal chunk to disk
  const { id, filePath } = await writeJournalChunk({
    lorePath,
    narrativeName,
    prev: prevChunks?.id ?? null,
    status,
    topics: effectiveTopics,
    convergence: null,
    theta: null,
    magnitude: null,
    content: text,
    intent: narrative.intent,
    conceptDesignations,
    conceptRefs: resolvedConceptIds.length > 0 ? resolvedConceptIds : null,
    symbolRefs: resolvedSymbolIds.length > 0 ? resolvedSymbolIds : null,
    refs: refs && refs.length > 0 ? refs : null,
  });

  // Insert into DB
  insertChunk(db, {
    id,
    filePath,
    flType: "journal",
    narrativeId: narrative.id,
    status,
    topics: effectiveTopics,
    convergence: null,
    theta: null,
    magnitude: null,
    createdAt: new Date().toISOString(),
    conceptDesignations,
    conceptRefs: resolvedConceptIds.length > 0 ? resolvedConceptIds : null,
    symbolRefs: resolvedSymbolIds.length > 0 ? resolvedSymbolIds : null,
    fileRefs: refs && refs.length > 0 ? refs : null,
  });

  // FTS indexed now so query() can find via BM25; embedding added at close time
  insertFtsContent(db, text, id);

  // Update narrative entry count
  updateNarrativeMetrics(db, narrative.id, {
    entry_count: narrative.entry_count + 1,
  });

  // Generate note
  const notes: string[] = [];
  if (status === "dead-end") {
    notes.push("Dead end recorded — future agents will see this");
  } else if (narrative.entry_count + 1 >= 10) {
    notes.push(`${narrative.entry_count + 1} entries — consider closing soon`);
  }

  return { saved: true, note: notes.length > 0 ? notes.join(". ") : undefined };
}

export async function queryConcepts(
  db: Database,
  text: string,
  config: LoreConfig,
  embedder: Embedder,
  opts?: {
    search?: boolean;
    brief?: boolean;
    codePath?: string;
    summary_generator?: Pick<Generator, "generate" | "generateWithMeta">;
    executive_summary?: {
      enabled: boolean;
      model: string;
      reasoning?: ReasoningLevel;
      max_matches: number;
      max_chars: number;
      source_max_chars?: number;
      /** Override the full-summary system prompt (prompt experimentation). */
      system_prompt?: string;
      /** Override the concise-mode system prompt (prompt experimentation). */
      concise_system_prompt?: string;
    };
    onProgress?: (message: string) => void;
    /** Code-specialized embedder for a second vector search lane */
    codeEmbedder?: Embedder | null;
    /** "code" injects bound symbol bodies alongside concept prose. "arch" returns prose only. */
    mode?: "arch" | "code";
    /** Return a concise, short-form answer. */
    concise?: boolean;
    /** Co-locate sibling chunks from a selected source chunk's file (default on). */
    file_aware_siblings?: boolean;
    /** Max sibling chunks pulled in per selected source file (default 4). */
    max_file_siblings?: number;
    /** Ask-pipeline trace logger — logs all queryConcepts stages when provided */
    tracer?: AskTracer;
    ask_debt?: {
      score: number | null;
      band: AskDebtBand;
    };
  },
): Promise<QueryResult> {
  const startedAtMs = Date.now();
  const generatedAt = new Date().toISOString();
  const retrievalCfg = config.ai.search?.retrieval;
  const retrievalOptsCfg = config.ai.search?.retrieval_opts;
  const askDebtBand = opts?.ask_debt?.band ?? "healthy";
  const retrievalMultiplier = askDebtRetrievalMultiplier(askDebtBand);
  const stalenessPenaltyMultiplier = askDebtStalenessPenaltyMultiplier(askDebtBand);
  const askDebtWarning = askDebtBandWarning(askDebtBand);
  const RETURN_LIMIT = Math.max(
    1,
    Math.round((retrievalCfg?.return_limit ?? 20) * retrievalMultiplier),
  );
  const VECTOR_LIMIT = Math.max(
    1,
    Math.round((retrievalCfg?.vector_limit ?? 100) * retrievalMultiplier),
  );
  const queryTimeouts = config.ai.search?.timeouts;
  const embeddingTimeoutMs = queryTimeouts?.embedding_ms;
  const rerankTimeoutMs = queryTimeouts?.rerank_ms;
  const summaryTimeoutMs = queryTimeouts?.executive_summary_ms;

  opts?.tracer?.log("query.start", {
    query: text,
    mode: opts?.mode ?? "arch",
    brief: opts?.brief ?? false,
    has_code_embedder: Boolean(opts?.codeEmbedder),
  });

  opts?.onProgress?.("embedding query");
  const embedStartMs = Date.now();
  let queryEmbedding: Float32Array;
  try {
    queryEmbedding = await embedder.embed(text, { timeoutMs: embeddingTimeoutMs });
  } catch (error) {
    throw new LoreError(
      "ASK_EMBEDDING_FAILED",
      `Query embedding failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  opts?.tracer?.log("embedding.done", {
    dim: queryEmbedding.length,
    elapsed_ms_local: Date.now() - embedStartMs,
  });

  opts?.onProgress?.("searching local matches");
  // Symbol search runs synchronously (FTS5) alongside async hybrid + web searches
  let symbolResults: ReturnType<typeof searchSymbols> = [];
  try {
    symbolResults = searchSymbols(db, text, { limit: 10 });
    if (symbolResults.length > 0) {
      symbolResults = await enrichSymbolResults(db, symbolResults, opts?.codePath);
    }
  } catch {
    // symbol_fts table may not exist yet — non-fatal
  }
  opts?.tracer?.log("symbols.done", {
    count: symbolResults.length,
    top5: symbolResults.slice(0, 5).map((s) => ({ name: s.name, kind: s.kind, file: s.file_path })),
  });

  let localSearch: Awaited<ReturnType<typeof hybridSearch>>;
  let webResults: Awaited<ReturnType<typeof webSearch>>;
  let journalSearch: Awaited<ReturnType<typeof hybridSearch>>;
  try {
    [localSearch, webResults, journalSearch] = await Promise.all([
      hybridSearch(db, embedder, text, config, {
        sourceType: "chunk",
        limit: RETURN_LIMIT,
        vectorLimit: VECTOR_LIMIT,
        queryEmbedding,
        textModel: config.ai.embedding.model,
        codeEmbedder: opts?.codeEmbedder,
        codeModel: config.ai.embedding.code?.model,
        codePath: opts?.codePath,
        mode: opts?.mode,
        tracer: opts?.tracer,
      }),
      opts?.search ? webSearch(text, config) : Promise.resolve([]),
      hybridSearch(db, embedder, text, config, {
        sourceType: "journal",
        limit:
          Math.max(1, retrievalCfg?.journal_group_limit ?? 10) *
          Math.max(1, retrievalCfg?.journal_entries_per_group ?? 3) *
          3,
        queryEmbedding,
        vectorLimit: Math.max(
          50,
          Math.max(1, retrievalCfg?.journal_group_limit ?? 10) *
            Math.max(1, retrievalCfg?.journal_entries_per_group ?? 3) *
            2,
        ),
        textModel: config.ai.embedding.model,
      }),
    ]);
  } catch (error) {
    throw new LoreError(
      "ASK_SEARCH_FAILED",
      `Local search failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const stateResults = localSearch.results;

  // ── Journal trail: surface investigation context from previous narratives ──
  const JOURNAL_GROUP_LIMIT = Math.max(1, retrievalCfg?.journal_group_limit ?? 10);
  const JOURNAL_ENTRIES_PER_GROUP = Math.max(1, retrievalCfg?.journal_entries_per_group ?? 3);
  const JOURNAL_MIN_SCORE = 0.005;

  opts?.tracer?.log("journal.search", {
    raw_candidates: journalSearch.stats.fused_candidates,
    below_min_score: journalSearch.results.filter((jr) => jr.score < JOURNAL_MIN_SCORE).length,
  });

  // Score-first journal grouping: two passes to avoid "first-narrative-wins" bias.
  //
  // Pass 1: iterate results in score order (hybridSearch returns sorted desc), collect all
  // entries above threshold capped per-narrative at JOURNAL_ENTRIES_PER_GROUP. No group limit
  // applied here — we want the globally best entries regardless of which narrative they're from.
  //
  // Pass 2: slice to JOURNAL_TOTAL_LIMIT (= GROUP_LIMIT × ENTRIES_PER_GROUP), then build
  // groups from the selected entries. Groups are formed from the winner set, not during
  // selection, so the display grouping never interferes with retrieval scoring.

  const JOURNAL_TOTAL_LIMIT = JOURNAL_GROUP_LIMIT * JOURNAL_ENTRIES_PER_GROUP;

  const tracing = Boolean(opts?.tracer);
  const traceCandidates: Array<{
    chunkId: string;
    score: number;
    content_preview: string;
    narrative_id: string | null;
    narrative_name: string | null;
    topics: string[];
    filter_reason: string;
  }> = [];

  // Pass 1: score-ordered collection, capped per narrative
  const perNarrativeCount = new Map<string, number>();
  const journalChunkMap = batchLoadChunksByIds(
    db,
    journalSearch.results.map((result) => result.chunkId),
  );
  const journalSelected: Array<{
    jr: HybridSearchResult;
    chunkRow: ChunkRow;
    narrativeId: string;
    topics: string[];
  }> = [];

  for (const jr of journalSearch.results) {
    if (jr.score < JOURNAL_MIN_SCORE) {
      if (tracing)
        traceCandidates.push({
          chunkId: jr.chunkId,
          score: jr.score,
          content_preview: jr.content.slice(0, 120),
          narrative_id: null,
          narrative_name: null,
          topics: [],
          filter_reason: "below_min_score",
        });
      continue;
    }
    const chunkRow = journalChunkMap.get(jr.chunkId);
    if (!chunkRow?.narrative_id) {
      if (tracing)
        traceCandidates.push({
          chunkId: jr.chunkId,
          score: jr.score,
          content_preview: jr.content.slice(0, 120),
          narrative_id: null,
          narrative_name: null,
          topics: [],
          filter_reason: "no_narrative_id",
        });
      continue;
    }
    const narrativeId = chunkRow.narrative_id;
    const count = perNarrativeCount.get(narrativeId) ?? 0;
    if (count >= JOURNAL_ENTRIES_PER_GROUP) {
      if (tracing)
        traceCandidates.push({
          chunkId: jr.chunkId,
          score: jr.score,
          content_preview: jr.content.slice(0, 120),
          narrative_id: narrativeId,
          narrative_name: null,
          topics: [],
          filter_reason: "entries_per_group_limit",
        });
      continue;
    }
    perNarrativeCount.set(narrativeId, count + 1);
    const topics: string[] = chunkRow.topics ? JSON.parse(chunkRow.topics) : [];
    journalSelected.push({ jr, chunkRow, narrativeId, topics });
  }

  // Pass 2: take top JOURNAL_TOTAL_LIMIT entries (already score-sorted from hybridSearch)
  const journalWinners = journalSelected.slice(0, JOURNAL_TOTAL_LIMIT);
  if (tracing) {
    for (const { jr, narrativeId, topics } of journalWinners) {
      traceCandidates.push({
        chunkId: jr.chunkId,
        score: jr.score,
        content_preview: jr.content.slice(0, 120),
        narrative_id: narrativeId,
        narrative_name: null,
        topics,
        filter_reason: "included",
      });
    }
    for (const { jr, narrativeId, topics } of journalSelected.slice(JOURNAL_TOTAL_LIMIT)) {
      traceCandidates.push({
        chunkId: jr.chunkId,
        score: jr.score,
        content_preview: jr.content.slice(0, 120),
        narrative_id: narrativeId,
        narrative_name: null,
        topics,
        filter_reason: "total_limit",
      });
    }
    opts?.tracer?.log("journal.candidates", { items: traceCandidates });
  }

  // Build narrativeGroupMap from winners
  const narrativeGroupMap = new Map<
    string,
    {
      narrativeRow: NarrativeRow | null;
      entries: JournalTrailEntry[];
      bestScore: number;
    }
  >();
  const narrativePositionMaps = new Map<string, Map<string, number>>();

  for (const { jr, chunkRow, narrativeId, topics } of journalWinners) {
    let group = narrativeGroupMap.get(narrativeId);
    if (!group) {
      const narrativeRow = getNarrative(db, narrativeId);
      group = { narrativeRow, entries: [], bestScore: 0 };
      narrativeGroupMap.set(narrativeId, group);
      const narrativeChunks = getJournalChunksForNarrative(db, narrativeId);
      const posMap = new Map<string, number>();
      for (let i = 0; i < narrativeChunks.length; i++) {
        posMap.set(narrativeChunks[i]!.id, i + 1);
      }
      narrativePositionMaps.set(narrativeId, posMap);
    }
    const posMap = narrativePositionMaps.get(narrativeId);
    group.entries.push({
      content: jr.content,
      topics,
      status: chunkRow!.status,
      created_at: chunkRow!.created_at,
      score: jr.score,
      entry_index: posMap?.get(jr.chunkId) ?? 0,
    });
    if (jr.score > group.bestScore) group.bestScore = jr.score;
  }

  // Build sorted groups with sibling topic context.
  // Primary: bestScore DESC. Tie-breaker: narrative closed_at DESC (newer narrative wins).
  const journalGroups: JournalTrailGroup[] = [...narrativeGroupMap.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1].bestScore - a[1].bestScore;
      if (scoreDiff !== 0) return scoreDiff;
      const aTime = a[1].narrativeRow?.closed_at ?? "";
      const bTime = b[1].narrativeRow?.closed_at ?? "";
      return bTime.localeCompare(aTime);
    })
    .map(([narrativeId, group]) => {
      const matchedTopics = new Set(group.entries.flatMap((e) => e.topics));
      const allTopics = getJournalTopicsForNarrative(db, narrativeId);
      const otherTopics = allTopics.filter((t) => !matchedTopics.has(t));

      return {
        narrative_name: group.narrativeRow?.name ?? "unknown",
        narrative_intent: group.narrativeRow?.intent ?? "",
        narrative_status: group.narrativeRow?.status ?? "closed",
        total_entries: group.narrativeRow?.entry_count ?? group.entries.length,
        matched_entries: group.entries,
        other_topics: otherTopics,
        opened_at: group.narrativeRow?.opened_at ?? "",
        closed_at: group.narrativeRow?.closed_at ?? null,
      };
    });

  opts?.tracer?.log("journal.groups", {
    groups: journalGroups.map((g) => ({
      narrative_name: g.narrative_name,
      narrative_intent: g.narrative_intent,
      best_score: g.matched_entries.reduce((max, e) => Math.max(max, e.score), 0),
      matched_entries: g.matched_entries.map((e) => ({
        score: e.score,
        topics: e.topics,
        content_preview: e.content.slice(0, 120),
        entry_index: e.entry_index,
      })),
    })),
  });

  // Optional rerank with Cohere via ai SDK
  let rerankedResults = stateResults;
  const rrCfg = config.ai.search?.rerank;
  const rerankEnabled = rrCfg?.enabled ?? false;
  const rerankModel = rrCfg?.model ?? "rerank-v3.5";
  const rerankWindow = rrCfg?.candidates ?? 20;
  let rerankAttempted = false;
  let rerankApplied = false;
  let rerankCandidates = Math.min(rerankWindow, stateResults.length);
  let rerankReason = "disabled";
  let rerankScores: number[] = [];
  if (!rerankEnabled) {
    rerankReason = "disabled";
  } else if (stateResults.length <= 1) {
    rerankReason = "insufficient candidates";
  } else if (text.length < 8) {
    rerankReason = "query too short";
  } else {
    rerankAttempted = true;
    opts?.onProgress?.("reranking matches");
    const candidates = stateResults.slice(0, rerankWindow).map((r) => ({
      content: r.content,
      payload: r,
    }));
    rerankCandidates = candidates.length;
    const beforeIds = candidates.map((c) => c.payload.chunkId);
    const rerankResult = await rerankResults(text, candidates, config, {
      timeoutMs: rerankTimeoutMs,
    });
    const ordered = rerankResult.ordered;
    const afterIds = ordered.map((c) => c.payload.chunkId);
    rerankApplied =
      beforeIds.length === afterIds.length && beforeIds.some((id, idx) => id !== afterIds[idx]);
    rerankReason = rerankResult.failed
      ? `fallback: ${rerankResult.error ?? "rerank failed"}`
      : rerankApplied
        ? "reordered"
        : "no order change";
    rerankedResults = ordered.map((c) => c.payload);
    rerankScores = rerankResult.scores;
    // Replace RRF scores with reranker relevance scores when rerank succeeded
    if (rerankApplied && !rerankResult.failed) {
      for (let i = 0; i < rerankedResults.length; i++) {
        if (i < rerankScores.length) {
          rerankedResults[i]!.score = rerankScores[i]!;
        }
      }
    }
    // Append any tail beyond candidate window if we sliced
    if (stateResults.length > candidates.length) {
      rerankedResults = rerankedResults.concat(stateResults.slice(candidates.length));
    }
  }

  opts?.tracer?.log("rerank.done", {
    applied: rerankApplied,
    reason: rerankReason,
    candidates_count: rerankCandidates,
    top5_scores: rerankScores.slice(0, 5),
  });

  // ── Structural boost: symbol bindings → concept score boost ──
  let structuralBoostEnabled = false;
  let structuralSymbolsMatched = 0;
  let structuralConceptsBoosted = 0;
  const structuralBoostMap: Record<string, { boost: number; symbols: string[] }> = {};

  try {
    if (symbolResults.length > 0) {
      structuralBoostEnabled = true;
      const symbolIds = symbolResults.map((s) => s.symbol_id);
      const matches = getConceptsForSymbols(db, symbolIds);

      if (matches.length > 0) {
        // Build concept → max boost from matched symbols
        const conceptBoosts = new Map<string, { boost: number; symbols: string[] }>();
        for (const m of matches) {
          const boost = 0.05 * m.confidence;
          const existing = conceptBoosts.get(m.concept_name);
          if (!existing || boost > existing.boost) {
            conceptBoosts.set(m.concept_name, {
              boost,
              symbols: [...(existing?.symbols ?? []), m.symbol_id],
            });
          } else {
            existing.symbols.push(m.symbol_id);
          }
        }

        structuralSymbolsMatched = new Set(matches.map((m) => m.symbol_id)).size;

        // Inject symbol-matched concepts not already in the candidate pool.
        // This ensures concepts that ranked beyond RETURN_LIMIT in vector/BM25
        // are still surfaced when a direct symbol-name match exists.
        const resultConceptNames = new Set(
          rerankedResults.map((r) => r.concept).filter((n): n is string => n != null),
        );
        const allActiveConcepts = getActiveConcepts(db);
        const activeConceptsByName = new Map(allActiveConcepts.map((c) => [c.name, c]));
        const boostReadTargets: Array<{ chunkId: string; filePath: string; conceptName: string }> =
          [];
        for (const [conceptName] of conceptBoosts) {
          if (resultConceptNames.has(conceptName)) continue;
          const conceptRow = activeConceptsByName.get(conceptName);
          if (!conceptRow) continue;
          const activeChunkId =
            conceptRow.active_chunk_id ?? getChunksForConcept(db, conceptRow.id).at(-1)?.id;
          if (!activeChunkId) continue;
          const chunkRow = getChunk(db, activeChunkId);
          if (!chunkRow) continue;
          resultConceptNames.add(conceptName);
          boostReadTargets.push({
            chunkId: activeChunkId,
            filePath: chunkRow.file_path,
            conceptName,
          });
        }

        const boostReads = await mapConcurrent(boostReadTargets, 6, async (target) => {
          try {
            const parsed = await readChunk(target.filePath);
            return {
              chunkId: target.chunkId,
              score: 1 / (config.rrf.k + 1),
              content: parsed.content,
              concept: target.conceptName,
              warning: undefined,
            } satisfies HybridSearchResult;
          } catch {
            return null;
          }
        });

        for (const read of boostReads) {
          if (!read) continue;
          rerankedResults.push(read);
        }

        // Apply boost and re-sort
        for (const r of rerankedResults) {
          const entry = conceptBoosts.get(r.concept ?? "");
          if (entry) {
            r.score += entry.boost;
            structuralConceptsBoosted++;
            structuralBoostMap[r.concept ?? ""] = entry;
          }
        }

        if (structuralConceptsBoosted > 0) {
          rerankedResults.sort((a, b) => b.score - a.score);
        }

        // Annotate symbol results with bound concepts
        const symbolToConcepts = new Map<string, string[]>();
        for (const m of matches) {
          const existing = symbolToConcepts.get(m.symbol_id);
          if (existing) {
            if (!existing.includes(m.concept_name)) existing.push(m.concept_name);
          } else {
            symbolToConcepts.set(m.symbol_id, [m.concept_name]);
          }
        }
        for (const sr of symbolResults) {
          const concepts = symbolToConcepts.get(sr.symbol_id);
          if (concepts) sr.bound_concepts = concepts;
        }
      }
    }
  } catch {
    // concept_symbols table may not exist — non-fatal
  }

  opts?.tracer?.log("boost.done", {
    symbols_matched: structuralSymbolsMatched,
    concepts_boosted: structuralConceptsBoosted,
  });

  // Get all drifted bindings once
  let allDriftedBindings: SymbolDriftResult[] = [];
  try {
    allDriftedBindings = getDriftedBindings(db);
  } catch {
    // concept_symbols table may not exist yet
  }

  // Index drifted bindings by concept_id
  const driftedByConceptId = new Map<string, number>();
  for (const drift of allDriftedBindings) {
    driftedByConceptId.set(drift.concept_id, (driftedByConceptId.get(drift.concept_id) ?? 0) + 1);
  }

  // Ranking staleness penalty uses σ(c) (knowledge-model spec §4.3): for
  // bound concepts, the drifted-binding RATIO — evidence that the code moved —
  // never wall-clock age, which punishes stable code. Age survives only as
  // the weak prior for unbound concepts, where no evidence exists.
  const stalenessDecayDays = config.thresholds?.staleness_days ?? 90;
  const sigmaBindingStats = getConceptBindingStats(db);
  const sigmaByConceptId = new Map<string, number>();
  const groundednessByConceptId = new Map<string, GroundednessResult>();
  for (const r of rerankedResults) {
    const chunk = getChunk(db, r.chunkId);
    const concept = chunk?.concept_id ? getConcept(db, chunk.concept_id) : null;
    if (!concept) continue;
    const stats = sigmaBindingStats.get(concept.id);
    if (!groundednessByConceptId.has(concept.id)) {
      groundednessByConceptId.set(concept.id, groundednessResidual(concept, stats));
    }
    if (stalenessDecayDays <= 0) continue;
    let sigma = sigmaByConceptId.get(concept.id);
    if (sigma == null) {
      sigma = stalenessSigma(concept, stats, chunk?.created_at, stalenessDecayDays);
      sigmaByConceptId.set(concept.id, sigma);
    }
    // Max 10% penalty at full σ for healthy debt bands; higher bands
    // increase it (capped at 30%) to favor verified-fresh concepts.
    const penalty = Math.min(0.3, 0.1 * sigma * stalenessPenaltyMultiplier);
    r.score = Math.max(0.01, r.score * (1 - penalty));
  }

  // Concept-level dedup: cap chunks sharing a concept/symbol name at two. One
  // slot starves questions that span two sections of the same document (the
  // concept is the file, so the second section never reaches the pack); more
  // than two lets source chunks from one symbol (e.g. test fixtures) consume
  // the summary slots. Entries without a concept name are never deduped.
  {
    // The staleness penalty above rescored entries, so restore score order —
    // the first N seen per concept must be its N best.
    rerankedResults.sort((a, b) => b.score - a.score);
    const perConcept = new Map<string, number>();
    const firstBody = new Map<string, string>();
    // The [Source:/Doc:] header differs between copies of one symbol in
    // near-fork repos; compare bodies with it stripped, or twin files consume
    // both slots with identical content and the second slot teaches nothing.
    const bodyOf = (content: string): string =>
      content.replace(/^\[(Source|Doc):[^\]]*\]\s*/g, "").slice(0, 2000);
    const deduped: HybridSearchResult[] = [];
    for (const r of rerankedResults) {
      if (!r.concept) {
        deduped.push(r);
        continue;
      }
      const kept = perConcept.get(r.concept) ?? 0;
      if (kept >= 2) continue;
      if (kept === 1 && firstBody.get(r.concept) === bodyOf(r.content)) continue;
      if (kept === 0) firstBody.set(r.concept, bodyOf(r.content));
      perConcept.set(r.concept, kept + 1);
      deduped.push(r);
    }
    rerankedResults = deduped;
  }


  // Build concept ID→name map for relation resolution
  const finalChunkMap = batchLoadChunksByIds(
    db,
    rerankedResults.map((result) => result.chunkId),
  );
  const finalConceptIds = [
    ...new Set(
      [...finalChunkMap.values()]
        .map((chunk) => chunk.concept_id)
        .filter((conceptId): conceptId is string => conceptId != null),
    ),
  ];
  const finalConceptMap = batchLoadConceptsByIds(db, finalConceptIds);
  const bindingSummariesByConceptId = batchLoadBindingSummariesByConceptIds(db, finalConceptIds);
  const filesByConceptId = batchLoadFilesByConceptIds(db, finalConceptIds);
  const lastNarrativesByConceptId = batchLoadLastNarrativesByConceptIds(db, finalConceptIds);
  const conceptNameMap = new Map<string, string>();
  for (const concept of finalConceptMap.values()) {
    conceptNameMap.set(concept.id, concept.name);
  }

  const results = rerankedResults.map((r) => {
    let content = r.content;
    let excerpts: string[] | undefined;
    if (opts?.brief) {
      excerpts = extractBriefExcerpts(r.content, text);
      content = excerpts.join("\n\n...\n\n");
    }

    const chunk = finalChunkMap.get(r.chunkId) ?? null;
    const concept = chunk?.concept_id ? (finalConceptMap.get(chunk.concept_id) ?? null) : null;

    // Get files, bindings, relations, and symbol drift
    const files = concept ? (filesByConceptId.get(concept.id) ?? []) : [];
    const bindingSummaries = concept ? (bindingSummariesByConceptId.get(concept.id) ?? []) : [];
    const symbolsBound = bindingSummaries.length;
    let symbolsDrifted = 0;
    let relationRows: ConceptRelationRow[] = [];
    if (concept) {
      symbolsDrifted = driftedByConceptId.get(concept.id) ?? 0;
      try {
        relationRows = getConceptRelations(db, { conceptId: concept.id });
      } catch {
        // pre-relation-table safety
      }
    }

    const symbolDrift: "none" | "drifted" = symbolsDrifted > 0 ? "drifted" : "none";

    // Build warnings
    const warnings: string[] = [];
    if (askDebtWarning) warnings.push(askDebtWarning);
    if (r.warning) warnings.push(r.warning);
    if (symbolsDrifted > 0) {
      warnings.push(`${symbolsDrifted} bound symbol(s) have changed since last update`);
    }
    // Axes, not columns: σ(c) and R(c) as computed above for this result set.
    // The persisted staleness column is frozen at 0 by close and would never
    // fire these warnings.
    const sigma = concept ? (sigmaByConceptId.get(concept.id) ?? null) : null;
    const groundedness = concept ? (groundednessByConceptId.get(concept.id) ?? null) : null;
    if (groundedness?.ungrounded) {
      warnings.push("concept has no symbol bindings — unverifiable against code");
    }
    if (sigma != null && sigma > 0.5) {
      warnings.push(`concept is stale (σ ${sigma.toFixed(2)})`);
    } else if (sigma != null && sigma > 0.4) {
      const lastUpdatedDate = new Date(chunk?.created_at ?? concept!.inserted_at);
      const ageDays = (Date.now() - lastUpdatedDate.getTime()) / (1000 * 60 * 60 * 24);
      warnings.push(
        `concept may need refresh — σ ${sigma.toFixed(2)}, last verified ${Math.round(ageDays)}d ago`,
      );
    }
    const warning = warnings.length > 0 ? warnings.join("; ") : undefined;

    // Resolve relation concept names
    const relations =
      relationRows.length > 0 && concept
        ? relationRows.map((rel) => {
            const isOutbound = rel.from_concept_id === concept.id;
            const otherId = isOutbound ? rel.to_concept_id : rel.from_concept_id;
            let otherName = conceptNameMap.get(otherId);
            if (!otherName) {
              const otherConcept = getConcept(db, otherId);
              if (otherConcept) {
                otherName = otherConcept.name;
                conceptNameMap.set(otherId, otherName);
              }
            }
            return {
              concept: otherName ?? otherId,
              direction: (isOutbound ? "outbound" : "inbound") as "outbound" | "inbound",
              type: rel.relation_type,
              weight: rel.weight,
            };
          })
        : undefined;

    // Map binding summaries to compact form
    const bindings =
      bindingSummaries.length > 0
        ? bindingSummaries.map((b) => ({
            symbol: b.symbol_name,
            kind: b.symbol_kind,
            file: b.file_path,
            line: b.line_start,
            type: b.binding_type,
            confidence: b.confidence,
          }))
        : undefined;

    // Cluster peers: other concepts in the same cluster
    let clusterPeers: string[] | undefined;
    let clusterSummary: string | undefined;
    if (concept?.cluster != null) {
      try {
        const peers = getConceptsByCluster(db, concept.cluster, concept.id);
        if (peers.length > 0) {
          clusterPeers = peers.map((p) => p.name);
          // Build deterministic cluster summary from peer names
          const allNames = [r.concept ?? concept.name, ...clusterPeers];
          const totalConcepts = allNames.length;
          // Extract common keyword segments from kebab-case names
          const wordFreq = new Map<string, number>();
          for (const name of allNames) {
            const words = name.split(/[-_\s]+/).filter((w) => w.length > 2);
            const unique = new Set(words);
            for (const w of unique) wordFreq.set(w, (wordFreq.get(w) ?? 0) + 1);
          }
          const commonWords = [...wordFreq.entries()]
            .filter(([, count]) => count >= Math.ceil(totalConcepts * 0.4))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 3)
            .map(([word]) => word);
          const domain = commonWords.length > 0 ? commonWords.join(", ") : "mixed";
          const relationCount = relationRows.length;
          clusterSummary = `${totalConcepts} concepts covering ${domain}. ${relationCount} relation(s) in neighborhood.`;
        }
      } catch {
        // pre-cluster safety
      }
    }

    // 2-hop neighbors: concepts reachable through 2 relation hops
    let neighbors2hop: Array<{ concept: string; path: string; weight?: number }> | undefined;
    if (concept && relationRows.length > 0) {
      try {
        const hop2 = get2HopNeighbors(db, concept.id);
        if (hop2.length > 0) {
          neighbors2hop = hop2.map((h) => {
            const viaName =
              conceptNameMap.get(h.via) ??
              (() => {
                const c = getConcept(db, h.via);
                if (c) conceptNameMap.set(c.id, c.name);
                return c?.name ?? h.via;
              })();
            const targetName =
              conceptNameMap.get(h.conceptId) ??
              (() => {
                const c = getConcept(db, h.conceptId);
                if (c) conceptNameMap.set(c.id, c.name);
                return c?.name ?? h.conceptId;
              })();
            return {
              concept: targetName,
              path: `→ ${viaName} → ${targetName}`,
              weight: h.weight,
            };
          });
          neighbors2hop.sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
        }
      } catch {
        // pre-relation safety
      }
    }

    // Last narrative that touched this concept
    const lastNarrative = concept ? lastNarrativesByConceptId.get(concept.id) : undefined;

    return {
      concept: r.concept ?? "unknown",
      content,
      summary: r.content.slice(0, 200),
      warning,
      excerpts,
      meta: {
        chunk_id: r.chunkId,
        files,
        score: r.score,
        residual: groundedness?.residual ?? concept?.residual ?? null,
        staleness: sigma,
        symbol_drift: symbolDrift,
        symbols_bound: symbolsBound,
        symbols_drifted: symbolsDrifted,
        last_updated: chunk?.created_at ?? concept?.inserted_at ?? "",
        cluster: concept?.cluster ?? null,
        cluster_summary: clusterSummary,
        cluster_peers: clusterPeers,
        relations,
        neighbors_2hop: neighbors2hop,
        bindings,
        last_narrative: lastNarrative,
      },
    };
  });

  opts?.tracer?.log("results.final", {
    count: results.length,
    items: results.map((r) => ({
      concept: r.concept,
      score: r.meta.score,
      warning: r.warning,
    })),
  });

  const summaryCfg = opts?.executive_summary;
  const summaryEnabled = summaryCfg?.enabled ?? true;
  const summaryModel = summaryCfg?.model ?? config.ai.generation.model;
  const summaryReasoning = summaryCfg?.reasoning;
  const summaryMaxMatches = Math.max(1, summaryCfg?.max_matches ?? 6);
  const summaryMaxChars = Math.max(200, summaryCfg?.max_chars ?? 1600);
  const summarySourceMaxChars = Math.max(summaryMaxChars, summaryCfg?.source_max_chars ?? 6000);
  const maxGroundingHits = Math.max(1, retrievalOptsCfg?.max_grounding_hits ?? 8);

  // Score-gated summary input: filter by min_relevance when reranker was applied
  const minRelevance = rrCfg?.min_relevance ?? 0;
  const summaryInput = rerankedResults
    .filter((r) => !rerankApplied || r.score >= minRelevance)
    .slice(0, summaryMaxMatches);

  // Representation guarantee: when retrieval surfaced direct code evidence, the
  // pack must include at least one source chunk. Concept and doc prose are
  // synthesized from past sessions and can be stale; rerankers reliably score
  // fluent prose above raw code, so an unguarded top-N can go all-prose — and
  // then no prompt rule can prefer current code the model never sees.
  if (summaryInput.length > 0 && !summaryInput.some((r) => r.content.startsWith("[Source:"))) {
    const bestSource = rerankedResults.find((r) => r.content.startsWith("[Source:"));
    if (bestSource) {
      summaryInput[summaryInput.length - 1] = bestSource;
    }
  }

  // File-aware expansion: chunking is per-symbol, so a file's meaning is split
  // across independently-ranked chunks. Retrieval routinely surfaces the chunk
  // that *uses* a symbol while the chunk that *defines* it — a module-level
  // constant, a sibling helper — ranks just below the cut, and the model then
  // reports that the evidence does not contain the answer. When a source chunk
  // makes the pack, bring its siblings from the same file along.
  if (opts?.file_aware_siblings !== false) {
    const selectedSourceFiles = new Map<string, number>();
    for (const item of summaryInput) {
      const row = finalChunkMap.get(item.chunkId);
      if (row?.fl_type === "source" && row.source_file_path) {
        selectedSourceFiles.set(row.source_file_path, (selectedSourceFiles.get(row.source_file_path) ?? 0) + 1);
      }
    }
    if (selectedSourceFiles.size > 0) {
      const alreadyIn = new Set(summaryInput.map((r) => r.chunkId));
      const siblings: typeof summaryInput = [];
      const perFileCap = Math.max(1, opts?.max_file_siblings ?? 4);
      for (const filePath of selectedSourceFiles.keys()) {
        let taken = 0;
        for (const candidate of rerankedResults) {
          if (taken >= perFileCap) break;
          if (alreadyIn.has(candidate.chunkId)) continue;
          const row = finalChunkMap.get(candidate.chunkId);
          if (row?.source_file_path !== filePath) continue;
          siblings.push(candidate);
          alreadyIn.add(candidate.chunkId);
          taken++;
        }
      }
      summaryInput.push(...siblings);
      opts?.tracer?.log("file_aware_siblings", {
        files: [...selectedSourceFiles.keys()],
        added: siblings.length,
      });
    }
  }

  // Call-site expansion: a definition chunk often makes the pack while the call
  // site holding the concrete values (a config object, a threshold) never ranks —
  // a short interface is lexically denser than the 300-line caller, so top-k
  // returns the type and the model reports the values as absent. The call_sites
  // table already stores every caller with its snippet; attach them as evidence.
  {
    // Expand from the pack chunks' FILES, not just their own symbol names: the
    // pack often holds a type or constant (RateLimiterConfig) while the callers
    // invoke the function defined beside it (useRateLimiter) — an interface has
    // no call sites, so expanding only the chunk's own name finds nothing.
    const packFiles = [
      ...new Set(
        summaryInput
          .map((item) => finalChunkMap.get(item.chunkId))
          .filter((row) => row?.fl_type === "source" && row.source_file_path)
          .map((row) => row!.source_file_path as string),
      ),
    ].slice(0, 8);
    // Per-file, in pack order, capped — one huge backend module must not fill
    // every slot before the fourth-ranked file's symbols are even considered.
    let packSymbols: string[] = [];
    try {
      const seen = new Set<string>();
      for (const filePath of packFiles) {
        const names = db
          .query<{ name: string }, [string]>(
            `SELECT DISTINCT s.name FROM symbols s
             JOIN source_files sf ON s.source_file_id = sf.id
             WHERE sf.file_path = ? AND s.kind IN ('function', 'method', 'constant')
             LIMIT 4`,
          )
          .all(filePath)
          .map((r) => r.name);
        for (const n of names) {
          if (!seen.has(n)) {
            seen.add(n);
            packSymbols.push(n);
          }
        }
        if (packSymbols.length >= 24) break;
      }
      packSymbols = packSymbols.slice(0, 24);
    } catch {
      // symbols table shape predates this query — expansion is best-effort
    }
    if (packSymbols.length > 0) {
      let callRows: Array<{
        callee_name: string;
        caller_name: string | null;
        line: number;
        snippet: string | null;
        file_path: string;
      }> = [];
      try {
        const ph = packSymbols.map(() => "?").join(", ");
        callRows = db
          .query<(typeof callRows)[number], string[]>(
            `SELECT cs.callee_name, cs.caller_name, cs.line, cs.snippet, sf.file_path
             FROM call_sites cs JOIN source_files sf ON cs.source_file_id = sf.id
             WHERE cs.callee_name IN (${ph})`,
          )
          .all(...packSymbols);
      } catch {
        // call_sites table may not exist yet (pre-migration)
      }
      const bySymbol = new Map<string, typeof callRows>();
      for (const row of callRows) {
        const group = bySymbol.get(row.callee_name) ?? [];
        group.push(row);
        bySymbol.set(row.callee_name, group);
      }
      const minScore = Math.min(...summaryInput.map((r) => r.score), 1);
      let added = 0;
      // Rank groups by query-term overlap in their snippets: a call site whose
      // arguments echo the question's words is evidence, one that does not is
      // plumbing. Ties break toward fewer callers (more specific).
      const queryTerms = text
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length > 3);
      const groupRelevance = (sites: typeof callRows): number => {
        const blob = sites
          .map((s) => `${s.snippet ?? ""} ${s.caller_name ?? ""}`)
          .join(" ")
          .toLowerCase();
        return queryTerms.reduce((n, t) => n + (blob.includes(t) ? 1 : 0), 0);
      };
      const ordered = [...bySymbol.entries()].sort(
        (a, b) => groupRelevance(b[1]) - groupRelevance(a[1]) || a[1].length - b[1].length,
      );
      for (const [symbol, sites] of ordered) {
        if (added >= 5) break;
        if (sites.length === 0 || sites.length > 12) continue;
        const lines = sites
          .slice(0, 6)
          .map(
            (s) =>
              `${s.file_path}:${s.line}${s.caller_name ? ` (in ${s.caller_name})` : ""}: ${(s.snippet ?? "").replace(/\s+/g, " ").slice(0, 200)}`,
          );
        summaryInput.push({
          ...summaryInput[0]!,
          chunkId: `callsites:${symbol}`,
          concept: `call sites of ${symbol}`,
          score: minScore,
          content: `[Call sites of ${symbol} — how it is invoked in practice]\n${lines.join("\n")}`,
        });
        added++;
      }
      opts?.tracer?.log("call_site_expansion", {
        symbols: packSymbols,
        added,
      });
    }
  }

  opts?.onProgress?.("grounding code evidence");

  // Detect source chunks — direct code reads that serve as authoritative grounding.
  // Track symbols with no concept binding so the agent can be nudged to bind them.
  const sourceChunksInInput = summaryInput.filter((r) => r.content.startsWith("[Source:"));
  const hasSourceChunks = sourceChunksInInput.length > 0;
  const unboundSourceSymbols: string[] = [];
  if (hasSourceChunks) {
    const candidateNames = [
      ...new Set(sourceChunksInInput.map((r) => r.concept).filter((n): n is string => n != null)),
    ];
    if (candidateNames.length > 0) {
      // Single batch query instead of one per symbol
      const ph = candidateNames.map(() => "?").join(", ");
      const boundRows = db
        .query<{ qualified_name: string }, string[]>(
          `SELECT DISTINCT s.qualified_name
           FROM concept_symbols cs
           JOIN symbols s ON cs.symbol_id = s.id
           WHERE s.name IN (${ph}) OR s.qualified_name IN (${ph})`,
        )
        .all(...candidateNames, ...candidateNames);
      const boundNames = new Set(boundRows.map((r) => r.qualified_name));
      for (const name of candidateNames) {
        if (!boundNames.has(name)) unboundSourceSymbols.push(name);
      }
    }
  }

  // Collect symbol lines for each matched concept for grounding
  const summaryInputConceptIds = [
    ...new Set(
      summaryInput
        .map((result) => finalChunkMap.get(result.chunkId)?.concept_id)
        .filter((conceptId): conceptId is string => conceptId != null),
    ),
  ];
  const summarySymbolLinesByConceptId = batchLoadSymbolLinesByConceptIds(
    db,
    summaryInputConceptIds,
  );
  const groundingMatches = summaryInput.map((result) => {
    const chunk = finalChunkMap.get(result.chunkId);
    const concept = chunk?.concept_id ? finalConceptMap.get(chunk.concept_id) : null;
    const symbolLines = concept ? (summarySymbolLinesByConceptId.get(concept.id) ?? []) : [];
    return {
      concept: result.concept ?? "unknown",
      score: result.score,
      content: result.content,
      lore_mind: "local",
      symbol_lines: symbolLines,
    };
  });
  const summaryGrounding = await collectSummaryGroundingEvidence(
    text,
    groundingMatches,
    opts?.codePath,
    db,
  );

  opts?.tracer?.log("grounding.done", {
    exactness_detected: summaryGrounding.exactness_detected,
    hits_total: summaryGrounding.hits_total,
    call_site_hits: summaryGrounding.call_site_hits?.length ?? 0,
  });

  let summaryAttempted = false;
  let summaryGenerated = false;
  let summaryReason = "disabled";
  let summaryUsage: GenerationUsage | undefined;
  let executiveSummary: ExecutiveSummary | undefined;

  if (!summaryEnabled) {
    summaryReason = "disabled";
  } else if (summaryInput.length === 0) {
    summaryReason = "no matches";
  } else if (!opts?.summary_generator) {
    summaryReason = "generator unavailable";
  } else {
    summaryAttempted = true;
    opts?.onProgress?.("generating executive summary");
    // Source and doc results carry no concept file metadata on a bootstrap mind,
    // but their content headers name exactly the file that was read — use it, or
    // "Key files" points at unrelated concepts while omitting the actual evidence.
    const summarySources: ProvenanceSource[] = results.slice(0, summaryMaxMatches).map((r) => {
      const provenance = parseEvidenceProvenance(r.summary ?? "");
      return {
        concept: r.concept,
        score: r.meta.score,
        files: r.meta.files.length > 0 ? r.meta.files : provenance ? [provenance.file] : [],
        staleness: r.meta.staleness,
        last_updated: r.meta.last_updated,
      };
    });
    const summaryStartMs = Date.now();

    // Built before the call so the pack — the evidence the model actually
    // sees, post-budgeting — can be traced. Retrieval traces without this
    // stage answer "what ranked" but not "what the model was shown".
    const evidencePack = summaryInput.map((r) => ({
      concept: r.concept ?? "unknown",
      score: r.score,
      content: budgetEvidenceContent(db, r.content, summaryMaxChars, summarySourceMaxChars, text),
    }));
    opts?.tracer?.log("pack", {
      items: evidencePack.map((p, i) => ({
        rank: i,
        concept: p.concept,
        score: Number(p.score.toFixed(4)),
        chars: p.content.length,
        truncated: p.content.length < (summaryInput[i]?.content.length ?? 0),
        preview: p.content.slice(0, 120),
      })),
      total_chars: evidencePack.reduce((n, p) => n + p.content.length, 0),
    });

    try {
      const summary = await generateExecutiveSummary(
        opts.summary_generator,
        text,
        evidencePack,
        rerankedResults.length,
        summaryReasoning,
        summaryTimeoutMs,
        {
          systemPrompt: opts?.concise
            ? (summaryCfg?.concise_system_prompt ?? CONCISE_EXECUTIVE_SUMMARY_SYSTEM_PROMPT)
            : summaryCfg?.system_prompt,
          concise: opts?.concise,
          codePath: opts?.codePath,
          grounding: summaryGrounding,
          symbolCount: symbolResults.length,
          sources: summarySources,
          journalGroups,
          symbolResults,
          hasSourceChunks,
          unboundSourceSymbols: unboundSourceSymbols.length > 0 ? unboundSourceSymbols : undefined,
          max_grounding_hits: maxGroundingHits,
        },
      );
      summaryUsage = summary._usage;
      const { _usage: _, ...cleanSummary } = summary;
      executiveSummary = cleanSummary;
      // The consult set for p(c): what the model was actually shown, minus
      // synthetic call-site groups (not concepts).
      (executiveSummary as { pack_concepts?: string[] }).pack_concepts = [
        ...new Set(
          summaryInput
            .filter((r) => !String(r.chunkId).startsWith("callsites:") && r.concept)
            .map((r) => r.concept as string),
        ),
      ];
      summaryGenerated = true;
      summaryReason = "ok";
      opts?.tracer?.log("summary.done", {
        kind: (executiveSummary as { kind?: string })?.kind ?? "generated",
        prompt_tokens: summaryUsage?.promptTokens ?? 0,
        completion_tokens: summaryUsage?.completionTokens ?? 0,
        elapsed_ms_local: Date.now() - summaryStartMs,
      });
    } catch (error) {
      throw new LoreError(
        "ASK_EXEC_SUMMARY_FAILED",
        `Executive summary generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  opts?.onProgress?.("formatting output");
  const generatedIn = formatElapsedMs(Date.now() - startedAtMs);
  opts?.tracer?.log("query.end", {
    total_results: results.length,
    journal_groups: journalGroups.length,
    total_elapsed_ms: Date.now() - startedAtMs,
  });

  return {
    meta: {
      query: text,
      generated_at: generatedAt,
      generated_in: generatedIn,
      brief: opts?.brief ?? false,
      scanned: {
        local_candidates: localSearch.stats.fused_candidates,
        returned_results: results.length,
        return_limit: RETURN_LIMIT,
        vector_limit: VECTOR_LIMIT,
        text_vector_candidates: localSearch.stats.text_vector_candidates,
        code_vector_candidates: localSearch.stats.code_vector_candidates,
        bm25_source_candidates: localSearch.stats.bm25_source_candidates,
        bm25_chunk_candidates: localSearch.stats.bm25_chunk_candidates,
        doc_vector_candidates: localSearch.stats.doc_vector_candidates,
        bm25_doc_candidates: localSearch.stats.bm25_doc_candidates,
        fused_candidates: localSearch.stats.fused_candidates,
        staleness_checks: 0,
        web_search_enabled: Boolean(opts?.search),
        web_results: webResults.length,
        journal_candidates: journalSearch.stats.fused_candidates,
        journal_results: journalGroups.length,
      },
      rerank: {
        enabled: rerankEnabled,
        attempted: rerankAttempted,
        applied: rerankApplied,
        model: rerankModel,
        candidates: rerankCandidates,
        reason: rerankReason,
        top_score: rerankScores.length > 0 ? rerankScores[0]! : null,
        min_score: rerankScores.length > 0 ? rerankScores[rerankScores.length - 1]! : null,
      },
      executive_summary: {
        enabled: summaryEnabled,
        attempted: summaryAttempted,
        generated: summaryGenerated,
        model: summaryModel,
        model_id: summaryUsage?.modelId ?? "",
        reason: summaryReason,
        source_matches: rerankedResults.length,
        usage: {
          prompt_tokens: summaryUsage?.promptTokens ?? 0,
          completion_tokens: summaryUsage?.completionTokens ?? 0,
          total_tokens: summaryUsage?.totalTokens ?? 0,
        },
      },
      grounding: {
        enabled: summaryGrounding.enabled,
        attempted: summaryGrounding.attempted,
        exactness_detected: summaryGrounding.exactness_detected,
        hits_total: summaryGrounding.hits_total,
        call_site_hits: summaryGrounding.call_site_hits?.length ?? 0,
        files_considered: summaryGrounding.files_considered,
        mode: summaryGrounding.mode,
        reason: summaryGrounding.reason,
      },
      structural_boost: {
        enabled: structuralBoostEnabled,
        symbols_matched: structuralSymbolsMatched,
        concepts_boosted: structuralConceptsBoosted,
        boost_map: structuralBoostMap,
      },
      ...(opts?.ask_debt
        ? {
            ask_debt: {
              score: opts.ask_debt.score,
              band: opts.ask_debt.band,
              retrieval_multiplier: retrievalMultiplier,
              staleness_penalty_multiplier: stalenessPenaltyMultiplier,
            },
          }
        : {}),
    },
    executive_summary: executiveSummary,
    results,
    web_results: webResults.length > 0 ? webResults : undefined,
    symbol_results: symbolResults.length > 0 ? symbolResults : undefined,
    journal_results: journalGroups.length > 0 ? journalGroups : undefined,
  };
}

function formatElapsedMs(elapsedMs: number): string {
  const ms = Math.max(0, Math.round(elapsedMs));
  if (ms < 1000) return `${ms}ms`;

  const seconds = ms / 1000;
  if (seconds < 60) return `${formatOneDecimal(seconds)}s`;

  const minutes = seconds / 60;
  if (minutes < 60) return `${formatOneDecimal(minutes)}m`;

  const hours = minutes / 60;
  if (hours < 24) return `${formatOneDecimal(hours)}h`;

  const days = hours / 24;
  return `${formatOneDecimal(days)}d`;
}

function formatOneDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

interface ProvenanceSource {
  concept: string;
  score: number;
  files: string[];
  staleness: number | null;
  last_updated: string;
}

function compactSnippet(text: string, maxChars: number): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= maxChars) return compact;
  return `${compact.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

const SUMMARY_EXPANSION_STOPWORDS = new Set([
  "about",
  "after",
  "also",
  "and",
  "are",
  "been",
  "being",
  "between",
  "both",
  "but",
  "can",
  "codebase",
  "concept",
  "concepts",
  "could",
  "does",
  "each",
  "for",
  "from",
  "have",
  "lore",
  "lores",
  "how",
  "into",
  "its",
  "local",
  "matches",
  "most",
  "not",
  "only",
  "other",
  "our",
  "out",
  "over",
  "same",
  "should",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "under",
  "use",
  "used",
  "using",
  "what",
  "when",
  "where",
  "which",
  "while",
  "with",
  "work",
]);

const SUMMARY_SHORT_TOKEN_WHITELIST = new Set([
  "ai",
  "db",
  "ml",
  "llm",
  "api",
  "sdk",
  "cli",
  "ux",
  "ui",
]);
const SUMMARY_EXPANSION_TOKEN_RE = /[a-z0-9]+/g;

function tokenizeForSummaryExpansion(text: string): string[] {
  const tokens = text.toLowerCase().match(SUMMARY_EXPANSION_TOKEN_RE);
  if (!tokens) return [];
  return tokens.filter((token) => {
    if (SUMMARY_EXPANSION_STOPWORDS.has(token)) return false;
    if (token.length <= 2 && !SUMMARY_SHORT_TOKEN_WHITELIST.has(token)) return false;
    if (/^\d+$/.test(token)) return false;
    return true;
  });
}

function collectSummaryExpansionHints(
  query: string,
  matches: Array<{ concept: string; content: string; lore_mind?: string }>,
  maxTerms: number,
): string[] {
  const queryTokens = new Set(tokenizeForSummaryExpansion(query));
  const scored = new Map<string, number>();
  const add = (term: string, weight: number): void => {
    if (queryTokens.has(term)) return;
    scored.set(term, (scored.get(term) ?? 0) + weight);
  };

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const rankWeight = Math.max(1, matches.length - i);

    for (const token of tokenizeForSummaryExpansion(match.concept)) {
      add(token, rankWeight * 3);
    }
    for (const token of tokenizeForSummaryExpansion(match.lore_mind ?? "")) {
      add(token, rankWeight * 2);
    }

    const excerptTokens = tokenizeForSummaryExpansion(compactSnippet(match.content, 320));
    const seen = new Set<string>();
    for (const token of excerptTokens) {
      if (seen.has(token)) continue;
      seen.add(token);
      add(token, rankWeight);
    }
  }

  return [...scored.entries()]
    .sort((a, b) => {
      if (Math.abs(b[1] - a[1]) > 1e-9) return b[1] - a[1];
      return a[0].localeCompare(b[0]);
    })
    .slice(0, Math.max(1, maxTerms))
    .map(([term]) => term);
}

interface SummaryGroundingHit {
  file: string;
  line: number;
  snippet: string;
  term: string;
}

export interface SummaryGroundingReport {
  enabled: boolean;
  attempted: boolean;
  exactness_detected: boolean;
  hits_total: number;
  files_considered: number;
  mode: "always-on";
  reason: string;
  hits: SummaryGroundingHit[];
  call_site_hits?: SummaryGroundingHit[];
}

const SUMMARY_GROUNDING_EXACTNESS_HINTS_RE =
  /\b(exact|file\s*path|function|method|where defined|line\b|symbol|entrypoint)\b/i;
const SUMMARY_GROUNDING_FILE_RE =
  /\b[\w./-]+\.(ts|tsx|js|jsx|mjs|cjs|json|md|toml|yaml|yml|sql)\b/g;
const SUMMARY_GROUNDING_INLINE_REF_RE = /`([^`]{2,120})`/g;
const SUMMARY_GROUNDING_SNIPPET_MAX = 400;

function createEmptySummaryGroundingReport(
  exactnessDetected: boolean,
  reason: string,
  attempted: boolean = false,
): SummaryGroundingReport {
  return {
    enabled: true,
    attempted,
    exactness_detected: exactnessDetected,
    hits_total: 0,
    files_considered: 0,
    mode: "always-on",
    reason,
    hits: [],
  };
}

function detectExactnessQuery(query: string): boolean {
  const lower = query.toLowerCase();
  if (SUMMARY_GROUNDING_EXACTNESS_HINTS_RE.test(lower)) return true;
  if (SUMMARY_GROUNDING_FILE_RE.test(query)) return true;
  SUMMARY_GROUNDING_FILE_RE.lastIndex = 0;
  if (SUMMARY_GROUNDING_INLINE_REF_RE.test(query)) return true;
  SUMMARY_GROUNDING_INLINE_REF_RE.lastIndex = 0;
  return false;
}

export async function collectSummaryGroundingEvidence(
  query: string,
  matches: Array<{
    concept: string;
    score: number;
    content: string;
    lore_mind?: string;
    symbol_lines?: ConceptSymbolLineRange[];
  }>,
  codePath?: string,
  db?: Database,
): Promise<SummaryGroundingReport> {
  const exactnessDetected = detectExactnessQuery(query);
  if (!codePath) {
    return createEmptySummaryGroundingReport(exactnessDetected, "no-code-path");
  }

  const allSymbolLines = matches.flatMap((m) => m.symbol_lines ?? []);
  if (allSymbolLines.length === 0) {
    return createEmptySummaryGroundingReport(
      exactnessDetected,
      "no-symbols-on-matched-concepts",
      true,
    );
  }

  const dedup = new Map<string, SummaryGroundingHit>();

  // Read symbol content from disk at query time
  const symbolReadTargets: Array<{ key: string; sym: ConceptSymbolLineRange }> = [];
  for (const sym of allSymbolLines) {
    const key = `${sym.file_path}:${sym.line_start}`;
    if (dedup.size + symbolReadTargets.length >= 30) break;
    if (dedup.has(key) || symbolReadTargets.some((target) => target.key === key)) continue;
    symbolReadTargets.push({ key, sym });
  }
  const symbolReads = await mapConcurrent(symbolReadTargets, 6, async ({ key, sym }) => {
    const content = await readSymbolContent(codePath, sym.file_path, sym.line_start, sym.line_end);
    if (!content) return null;
    return {
      key,
      hit: {
        file: sym.file_path,
        line: sym.line_start,
        snippet: compactSnippet(content, SUMMARY_GROUNDING_SNIPPET_MAX),
        term: sym.symbol_name,
      } satisfies SummaryGroundingHit,
    };
  });
  for (const read of symbolReads) {
    if (!read || dedup.has(read.key)) continue;
    dedup.set(read.key, read.hit);
  }

  // Collect call-site edges for matched symbols (bidirectional), coalesce adjacent
  const callSiteHits: SummaryGroundingHit[] = [];
  if (db) {
    const seenSymbols = new Set<string>();
    const callSiteReadTargets: Array<{
      key: string;
      file_path: string;
      lineStart: number;
      lineEnd: number;
      fallback: string;
      term: string;
    }> = [];
    for (const sym of allSymbolLines) {
      if (seenSymbols.has(sym.symbol_name)) continue;
      seenSymbols.add(sym.symbol_name);
      try {
        // Gather all raw call-sites for this symbol
        const rawSites: Array<{ file_path: string; line: number; term: string; fallback: string }> =
          [];

        // Upstream: who calls this symbol?
        const callers = getCallSitesForCallee(db, sym.symbol_name, { limit: 5 });
        for (const cs of callers) {
          rawSites.push({
            file_path: cs.file_path,
            line: cs.line,
            term: `calls ${sym.symbol_name}`,
            fallback: cs.snippet ?? sym.symbol_name,
          });
        }

        // Downstream: what does this symbol call?
        const callees = getCallSitesByCaller(db, sym.symbol_name, { limit: 8 });
        for (const cs of callees) {
          rawSites.push({
            file_path: cs.file_path,
            line: cs.line,
            term: `${sym.symbol_name} calls ${cs.callee_name}`,
            fallback: cs.snippet ?? cs.callee_name,
          });
        }

        // Sort by file then line for coalescing
        rawSites.sort((a, b) => a.file_path.localeCompare(b.file_path) || a.line - b.line);

        // Coalesce adjacent sites (same file, within 8 lines)
        const groups: Array<{
          file_path: string;
          lineStart: number;
          lineEnd: number;
          terms: string[];
          fallback: string;
        }> = [];
        for (const site of rawSites) {
          const last = groups[groups.length - 1];
          if (last && last.file_path === site.file_path && site.line - last.lineEnd <= 8) {
            last.lineEnd = Math.min(site.line + 6, last.lineStart + 14); // cap at 15 lines
            last.terms.push(site.term);
          } else {
            groups.push({
              file_path: site.file_path,
              lineStart: site.line,
              lineEnd: site.line + 6,
              terms: [site.term],
              fallback: site.fallback,
            });
          }
        }

        // Read each coalesced group as one evidence block
        for (const group of groups) {
          if (callSiteReadTargets.length >= 30) break;
          const key = `call:${group.file_path}:${group.lineStart}`;
          if (dedup.has(key) || callSiteReadTargets.some((target) => target.key === key)) continue;
          callSiteReadTargets.push({
            key,
            file_path: group.file_path,
            lineStart: group.lineStart,
            lineEnd: group.lineEnd,
            fallback: group.fallback,
            term: group.terms.join(", "),
          });
        }
      } catch {
        // call_sites table may not exist yet (pre-migration)
      }
    }
    const callSiteReads = await mapConcurrent(callSiteReadTargets, 6, async (target) => {
      const content = await readSymbolContent(
        codePath,
        target.file_path,
        target.lineStart,
        target.lineEnd,
      );
      return {
        key: target.key,
        hit: {
          file: target.file_path,
          line: target.lineStart,
          snippet: content
            ? compactSnippet(content, SUMMARY_GROUNDING_SNIPPET_MAX)
            : target.fallback,
          term: target.term,
        } satisfies SummaryGroundingHit,
      };
    });
    for (const read of callSiteReads) {
      if (callSiteHits.length >= 30) break;
      if (dedup.has(read.key)) continue;
      callSiteHits.push(read.hit);
      dedup.set(read.key, read.hit);
    }
  }

  const evidence = [...dedup.values()].slice(0, 30);
  const filesConsidered = new Set([
    ...evidence.map((hit) => hit.file),
    ...callSiteHits.map((hit) => hit.file),
  ]).size;
  if (evidence.length === 0 && callSiteHits.length === 0) {
    return createEmptySummaryGroundingReport(exactnessDetected, "no-hits", true);
  }

  return {
    enabled: true,
    attempted: true,
    exactness_detected: exactnessDetected,
    hits_total: evidence.length + callSiteHits.length,
    files_considered: filesConsidered,
    mode: "always-on",
    reason: "ok",
    hits: evidence,
    call_site_hits: callSiteHits.length > 0 ? callSiteHits : undefined,
  };
}

function formatGroundingEvidenceForPrompt(report: SummaryGroundingReport, maxHits = 8): string {
  if (report.hits.length === 0) return "- none";
  return report.hits
    .slice(0, maxHits)
    .map((hit) => `- ${hit.file}:${hit.line} | ${hit.snippet}`)
    .join("\n");
}

function formatCallSiteEvidenceForPrompt(report: SummaryGroundingReport, maxHits = 8): string {
  if (!report.call_site_hits || report.call_site_hits.length === 0) return "";
  const lines = report.call_site_hits
    .slice(0, maxHits)
    .map((hit) => `- ${hit.file}:${hit.line} | ${hit.snippet} [${hit.term}]`);
  return `\nCall graph (callers and callees of matched symbols):\n${lines.join("\n")}\n`;
}

function formatJournalEvidenceForPrompt(groups: JournalTrailGroup[]): string {
  if (groups.length === 0) return "";
  const lines: string[] = ["Investigation trail (recent agent findings from closed narratives):"];
  for (const group of groups.slice(0, 5)) {
    const status = group.narrative_status === "closed" ? "closed" : group.narrative_status;
    lines.push(`\nNarrative: "${group.narrative_name}" — ${group.narrative_intent} (${status})`);
    for (const entry of group.matched_entries.slice(0, 3)) {
      const pos =
        entry.entry_index > 0 ? `Entry ${entry.entry_index}/${group.total_entries}` : "Entry";
      const topics = entry.topics.length > 0 ? ` [${entry.topics.join(", ")}]` : "";
      lines.push(`  ${pos}: "${compactSnippet(entry.content, 400)}"${topics}`);
    }
  }
  return lines.join("\n");
}

function formatSymbolEvidenceForPrompt(results: SymbolSearchResult[]): string {
  if (results.length === 0) return "";
  const sections: string[] = ["Symbol matches (code search hits):"];
  for (const r of results.slice(0, 5)) {
    const parts: string[] = [];
    parts.push(`\n${r.name} (${r.kind}) — ${r.file_path}:${r.line_start}-${r.line_end}`);
    if (r.signature) {
      parts.push(`Signature: ${r.signature}`);
    }
    if (r.bound_concepts && r.bound_concepts.length > 0) {
      parts.push(`Bound to: [${r.bound_concepts.join(", ")}]`);
    }
    if (r.call_graph) {
      if (r.call_graph.callers.length > 0) {
        parts.push("\nCalled by:");
        for (const c of r.call_graph.callers) {
          const snip = c.snippet ? ` | ${c.snippet}` : "";
          parts.push(`- ${c.name} [${c.file}:${c.line}]${snip}`);
        }
      }
      if (r.call_graph.callees.length > 0) {
        parts.push("\nCalls:");
        for (const c of r.call_graph.callees) {
          const snip = c.snippet ? ` | ${c.snippet}` : "";
          parts.push(`- ${c.name} [${c.file}:${c.line}]${snip}`);
        }
      }
    }
    sections.push(parts.join("\n"));
    sections.push("---");
  }
  return sections.join("\n");
}

export const DEFAULT_EXECUTIVE_SUMMARY_SYSTEM_PROMPT = `You generate grounded executive summaries for codebase knowledge queries.
Non-negotiable rules:
- Treat the provided evidence pack as the only source of truth.
- Answer the user's query directly in 1-2 opening sentences.
- Then provide 2-4 concise bullets with the strongest supporting points.
- Attribute evidence to concept names, and include lore names when context spans multiple lore minds.
- Do not invent facts. If evidence is partial or conflicting, say so explicitly.
- Do not speculate beyond provided evidence, even if the query suggests adjacent topics.
- For exact path/function claims, include inline citations like [path/to/file.ts:42].
- Keep output under 512 words.
- Do not include markdown headings.
- After each bullet, append the source concept name(s) in double brackets: [[concept-name]].
- If a bullet draws from multiple concepts: [[concept-a, concept-b]].
- Every factual bullet must have at least one [[source]].
- Before asserting a value or behavior, read the relevant evidence line by line and follow
  the order statements execute in. A later line can overwrite what an earlier line set, and
  a slice or comparison expression may not do what its surrounding code implies.
- Reproduce identifiers, literal values, and error messages exactly as they appear in the
  evidence rather than paraphrasing them.
- Answer every part of the question, including negative or contrastive parts such as which
  case does not apply.

Evidence hierarchy (highest to lowest priority):
1. Investigation trail — recent agent observations from closed narratives. These contain specific discoveries, exact formulas, code references, and rationale. When investigation findings contain explicit values (constants, formulas, weights), prefer them over paraphrased concept content.
2. Integrated knowledge — concept content synthesized from multiple investigations. Comprehensive but may generalize specifics.
3. Code anchors — symbol names with file:line locations. Use for grounding claims to source code.
4. Grounding evidence — file:line snippets from code search. Use for inline citations.

Conflict resolution:
- Evidence whose Source Content begins with "[Source:" is read directly from the current code at ingest time. When it contradicts concept or doc prose on any value, condition, or behavior, the source block wins — prose is synthesized from past sessions and may be stale.
- If investigation trail entries contain specific numeric values, formulas, or constants that differ from concept content, the investigation trail is more likely correct (it was observed directly from source code).
- If concept content provides broader context that investigation entries lack, combine both.`;

/**
 * Where to look next when the indexed evidence can't fully answer.
 *
 * Lore's job is to guide the next search, not just answer: an agent that gets
 * "No information available." is stranded, while one that gets three file:line
 * candidates keeps moving. Built from what retrieval DID surface — top symbol
 * hits and grounding locations — so it costs no extra calls.
 */
function formatLookNext(
  symbolResults: SymbolSearchResult[] | undefined,
  grounding: SummaryGroundingReport | undefined,
  maxTargets = 4,
): string | null {
  const targets: string[] = [];
  const seen = new Set<string>();
  for (const sym of symbolResults ?? []) {
    const key = `${sym.file_path}:${sym.line_start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(`${sym.file_path}:${sym.line_start} (${sym.name})`);
    if (targets.length >= maxTargets) break;
  }
  for (const hit of grounding?.hits ?? []) {
    if (targets.length >= maxTargets) break;
    const key = `${hit.file}:${hit.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push(`${hit.file}:${hit.line}`);
  }
  if (targets.length === 0) return null;
  return `Look next: ${targets.join(", ")}.`;
}

export const CONCISE_EXECUTIVE_SUMMARY_SYSTEM_PROMPT = `You answer questions with the shortest correct answer possible.
Non-negotiable rules:
- Treat the provided evidence pack as the only source of truth.
- Answer in 1-2 sentences maximum. Prefer a single phrase or value when the question asks for a specific fact.
- Answer the question that was actually asked. A "why" or "what is the reason"
  question wants the purpose, tradeoff, or consequence — naming the mechanism that
  implements it is a wrong answer to that question. Prefer "so that X" over "it does X".
- Do not narrate your process, do not list supporting evidence, do not add unrequested background.
- Do not include bullets, markdown headings, or citations.
- Code in the evidence is evidence of its own design: state the reason it demonstrates.
  Claim only what the evidence supports.
- Evidence beginning with "[Source:" is read directly from the current code. When it
  contradicts concept or doc prose on any value or behavior, the source block wins —
  prose comes from past sessions and may be stale.
- Say "No information available." only when the evidence pack is genuinely silent
  on the subject — never merely because the reason is shown in code rather than prose.
- Keep output under 50 words.`;

function parseClaimAttributions(narrative: string): {
  cleaned: string;
  claims: Array<{ text: string; source_concepts: string[] }>;
} {
  const claims: Array<{ text: string; source_concepts: string[] }> = [];
  const lines = narrative.split("\n");
  const cleanedLines: string[] = [];

  for (const line of lines) {
    const matches = [...line.matchAll(/\[\[([^\]]+)\]\]/g)];
    if (matches.length > 0) {
      const concepts = matches.flatMap((m) => m[1]!.split(",").map((s) => s.trim()));
      const cleaned = line.replace(/\s*\[\[[^\]]+\]\]/g, "");
      // Note: confidence is computed later in generateExecutiveSummary
      claims.push({ text: cleaned.trim(), source_concepts: concepts });
      cleanedLines.push(cleaned);
    } else {
      cleanedLines.push(line);
    }
  }

  return { cleaned: cleanedLines.join("\n"), claims };
}

export type GenerationUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  modelId: string;
};

export async function generateExecutiveSummary(
  generator: Pick<Generator, "generate" | "generateWithMeta">,
  query: string,
  matches: Array<{
    concept: string;
    score: number;
    content: string;
    lore_mind?: string;
    symbol_lines?: ConceptSymbolLineRange[];
  }>,
  totalMatches: number,
  reasoning: ReasoningLevel | undefined,
  timeoutMs?: number,
  opts?: {
    systemPrompt?: string;
    /** Concise mode: the answer contract forbids citations, so suppress both
     *  model-emitted [file:line] refs and the renderer's post-hoc injection. */
    concise?: boolean;
    codePath?: string;
    grounding?: SummaryGroundingReport;
    symbolCount?: number;
    sources?: ProvenanceSource[];
    journalGroups?: JournalTrailGroup[];
    symbolResults?: SymbolSearchResult[];
    /** True when the evidence pack contains direct source code chunks — authoritative grounding. */
    hasSourceChunks?: boolean;
    /** Symbol names used for source-chunk grounding that have no concept binding yet. */
    unboundSourceSymbols?: string[];
    /** Max grounding/call-site hits to include in the prompt (default 8). */
    max_grounding_hits?: number;
  },
): Promise<ExecutiveSummary & { _usage?: GenerationUsage }> {
  const system = opts?.systemPrompt ?? DEFAULT_EXECUTIVE_SUMMARY_SYSTEM_PROMPT;
  const grounding =
    opts?.grounding ?? (await collectSummaryGroundingEvidence(query, matches, opts?.codePath));
  const maxGroundingHits = opts?.max_grounding_hits ?? 8;
  const loreCount = new Set(matches.map((m) => m.lore_mind ?? "local")).size;
  const expansionHints = collectSummaryExpansionHints(query, matches, 8);
  const expansionHintsText =
    expansionHints.length > 0 ? expansionHints.map((hint) => `- ${hint}`).join("\n") : "- none";
  const groundingEvidenceText = formatGroundingEvidenceForPrompt(grounding, maxGroundingHits);
  const callSiteEvidenceText = formatCallSiteEvidenceForPrompt(grounding, maxGroundingHits);

  const sources = opts?.sources ?? [];
  const journalGroups = opts?.journalGroups ?? [];
  const symbolResultsForPrompt = opts?.symbolResults ?? [];
  const conceptCount = matches.length;
  const fileCount = grounding.files_considered;
  const symbolCount = opts?.symbolCount ?? 0;
  const journalEntryCount = journalGroups.reduce((sum, g) => sum + g.matched_entries.length, 0);
  const counts = {
    concepts: conceptCount,
    files: fileCount,
    symbols: symbolCount,
    journal_entries: journalEntryCount,
  };
  // Concise answers carry no citations: an empty list here also disables the
  // renderer's post-hoc [file:line] injection (renderNarrativeWithCitations).
  // Pack provenance first: the files actually read for this answer. Grounding
  // hits depend on bindings and term matches a bootstrap mind doesn't have yet,
  // so without this a fresh mind produces answers with no file references at
  // all — fatal for a tool whose job is telling agents where to look.
  const packCitations = opts?.concise
    ? []
    : matches
        .map((m) => ({ provenance: parseEvidenceProvenance(m.content), term: m.concept }))
        .filter(
          (c): c is { provenance: { file: string; line: number }; term: string } =>
            c.provenance != null,
        )
        .map((c) => ({
          file: c.provenance.file,
          line: c.provenance.line,
          snippet: "",
          term: c.term,
        }));
  // Implementation files point first; tests keep their slot but never lead.
  packCitations.sort((a, b) => Number(isTestFilePath(a.file)) - Number(isTestFilePath(b.file)));
  const seenCitationFiles = new Set(packCitations.map((c) => c.file));
  const citations = opts?.concise
    ? []
    : [
        ...packCitations,
        ...grounding.hits
          .filter((h) => !seenCitationFiles.has(h.file))
          .map((h) => ({
            file: h.file,
            line: h.line,
            snippet: h.snippet,
            term: h.term,
          })),
        ...(grounding.call_site_hits ?? [])
          .filter((h) => !seenCitationFiles.has(h.file))
          .map((h) => ({
            file: h.file,
            line: h.line,
            snippet: h.snippet,
            term: h.term,
          })),
      ];

  const journalEvidenceText = formatJournalEvidenceForPrompt(journalGroups);
  const symbolEvidenceText = formatSymbolEvidenceForPrompt(symbolResultsForPrompt);

  const context = matches
    .map(
      (m, i) => `Evidence ${i + 1}:
Lore Mind: ${m.lore_mind ?? "local"}
Concept: ${m.concept}
Relevance: ${m.score.toFixed(4)}
Source Content:
${m.content}`,
    )
    .join("\n\n---\n\n");

  const sourceChunkNote =
    opts?.unboundSourceSymbols && opts.unboundSourceSymbols.length > 0
      ? `\nAuthoritative source code blocks are present in the evidence pack (entries whose Source Content begins with "[Source:"). These are direct reads from source files — treat them as ground truth. Quote exact values, conditions, and logic from them verbatim rather than paraphrasing.\n`
      : "";

  const user = `Task framing:
Primary question:
${query}

Evidence scope:
- Provided matches: ${matches.length}
- Total matched concepts before truncation: ${totalMatches}
- Lore minds represented: ${loreCount}

Minor query expansion hints (for interpreting intent, not for adding new facts):
${expansionHintsText}
${sourceChunkNote}
Grounding instructions:
- Use only the evidence pack below.
- Prioritize higher-relevance evidence when selecting supporting bullets.
- If evidence is stale, partial, or conflicting, state uncertainty directly.

Grounding evidence (file:line + snippet):
${groundingEvidenceText}
${callSiteEvidenceText}${journalEvidenceText ? `\n${journalEvidenceText}\n` : ""}${symbolEvidenceText ? `\n${symbolEvidenceText}\n` : ""}
Evidence pack:
${context}`;

  const genResult = await generator.generateWithMeta(system, user, {
    timeoutMs,
    reasoning,
    scope: "executive_summary",
  });
  const generated = genResult.text.trim();

  // Source chunks in the evidence pack ARE direct code grounding — bypass the exactness gate.
  if (grounding.exactness_detected && grounding.hits_total === 0 && !opts?.hasSourceChunks) {
    return {
      narrative: "",
      kind: "uncertain",
      uncertainty_reason: [
        "Could not find grounded code references for exact path/function claims",
        formatLookNext(opts?.symbolResults, grounding),
      ]
        .filter(Boolean)
        .join(" "),
      sources,
      citations: [],
      counts,
      unbound_source_symbols: opts?.unboundSourceSymbols,
    };
  }
  if (generated.length === 0) {
    return {
      narrative: "",
      kind: "uncertain",
      uncertainty_reason: [
        grounding.exactness_detected
          ? "Could not produce a grounded exact summary from the available evidence"
          : "Could not produce a grounded summary from available evidence",
        formatLookNext(opts?.symbolResults, grounding),
      ]
        .filter(Boolean)
        .join(" "),
      sources,
      citations: [],
      counts,
      unbound_source_symbols: opts?.unboundSourceSymbols,
    };
  }
  // For non-exactness queries, strip any LLM-generated [file:line] citations
  // so our controlled per-term placement is the only source of inline refs.
  // Concise mode strips unconditionally: its contract is a bare 1-2 sentence
  // answer, and citation tails measurably read as noise to consumers.
  const cleanedGenerated =
    opts?.concise || !grounding.exactness_detected
      ? generated.replace(/\s*\[[^\]\s]+:\d+\]/g, "")
      : generated;
  const refusalRe = /^no information available\.?$/i;
  const finalGenerated =
    opts?.concise && refusalRe.test(cleanedGenerated.trim())
      ? [cleanedGenerated.trim(), formatLookNext(opts?.symbolResults, grounding)]
          .filter(Boolean)
          .join(" ")
      : cleanedGenerated;
  const { cleaned: narrativeWithoutMarkers, claims } = parseClaimAttributions(finalGenerated);

  // Compute per-claim confidence from source metrics
  const claimsWithConfidence = claims.map((claim) => {
    const sourceMetrics = claim.source_concepts
      .map((name) => sources.find((s) => s.concept === name))
      .filter((s): s is NonNullable<typeof s> => s != null);

    if (sourceMetrics.length === 0) {
      return { ...claim, confidence: 0.5, max_staleness: undefined }; // unknown sources → neutral
    }

    const mean = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length;
    const freshness = mean(sourceMetrics.map((m) => 1 - (m.staleness ?? 0.5)));
    const relevance = mean(sourceMetrics.map((m) => m.score)); // scores are already [0,1] similarity
    const corroboration = Math.min(1, sourceMetrics.length / 3);

    return {
      ...claim,
      confidence: 0.4 * freshness + 0.4 * relevance + 0.2 * corroboration,
      max_staleness: Math.max(...sourceMetrics.map((m) => m.staleness ?? 0)),
    };
  });

  return {
    narrative: narrativeWithoutMarkers,
    kind: "generated",
    sources,
    citations,
    counts,
    claims: claimsWithConfidence.length > 0 ? claimsWithConfidence : undefined,
    unbound_source_symbols:
      opts?.unboundSourceSymbols && opts.unboundSourceSymbols.length > 0
        ? opts.unboundSourceSymbols
        : undefined,
    _usage: {
      promptTokens: genResult.usage.promptTokens,
      completionTokens: genResult.usage.completionTokens,
      totalTokens: genResult.usage.totalTokens,
      modelId: genResult.modelId,
    },
  };
}

/** Header hybridSearch prepends to source-chunk evidence: `[Source: path:start-end]`. */
const DOC_EVIDENCE_HEADER = /^\[Doc: ([^\]>]+?)(?: > [^\]]*)?\]/;

/** File(:line) provenance carried by a source or doc chunk's own content header. */
export function parseEvidenceProvenance(
  content: string,
): { file: string; line: number } | null {
  const source = SOURCE_EVIDENCE_HEADER.exec(content);
  if (source) return { file: source[1]!, line: Number(source[2]) };
  const doc = DOC_EVIDENCE_HEADER.exec(content);
  if (doc) return { file: doc[1]!.trim(), line: 1 };
  return null;
}

const SOURCE_EVIDENCE_HEADER = /^\[Source: (.+):(\d+)-(\d+)\]/;

/**
 * Budget one evidence match for the summary prompt.
 *
 * Prose is front-loaded, so head-truncation costs little. Code is not: a class puts its
 * docstring first and its discriminating methods last, so slicing the head silently drops
 * the implementation the question is usually about — e.g. `URLPattern.__lt__`, which is the
 * whole answer to "which proxy pattern wins", sits 3.6k chars into a 3.8k class body.
 * Source chunks therefore get their own larger budget, and a chunk that still overflows
 * gets an index of the members below the cut so they remain nameable and citable.
 */
/**
 * Choose which slice of an oversized source chunk to keep.
 *
 * Head truncation loses the answer whenever it lives deep inside a long
 * function — the trigger condition three hundred lines into a close routine,
 * the reset statement after an early return. When the query gives us terms to
 * look for, center the window on the densest run of matches instead, keeping
 * some leading context so the reader still sees what they are inside of.
 */
function keepRelevantWindow(content: string, maxChars: number, query?: string): string {
  if (content.length <= maxChars) return content;
  const terms: string[] = [
    ...new Set<string>(
      expandCamelCase(query ?? "")
        .toLowerCase()
        .split(/[^a-z0-9_]+/)
        .filter((t: string) => t.length > 3),
    ),
  ];
  if (terms.length === 0) return content.slice(0, maxChars);

  const lines = content.split("\n");
  const scores = lines.map((line) => {
    const lower = line.toLowerCase();
    return terms.reduce((score, term) => (lower.includes(term) ? score + 1 : score), 0);
  });
  if (scores.every((s) => s === 0)) return content.slice(0, maxChars);

  // Slide a line window sized to roughly maxChars and take the densest one.
  const avgLineLen = Math.max(1, Math.round(content.length / Math.max(1, lines.length)));
  const windowLines = Math.max(20, Math.floor(maxChars / avgLineLen));
  let best = 0;
  let bestScore = -1;
  for (let start = 0; start + 1 <= lines.length; start += Math.max(1, Math.floor(windowLines / 4))) {
    let score = 0;
    for (let i = start; i < Math.min(start + windowLines, lines.length); i++) score += scores[i]!;
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }
  const lead = Math.min(best, 12);
  const head = lines.slice(0, lead).join("\n");
  const window = lines.slice(best, best + windowLines).join("\n");
  const marker = best > lead ? `\n… [${best - lead} lines omitted]\n` : "\n";
  return `${head}${marker}${window}`.slice(0, maxChars);
}

export function budgetEvidenceContent(
  db: Database,
  content: string,
  proseMaxChars: number,
  sourceMaxChars: number,
  query?: string,
): string {
  const header = SOURCE_EVIDENCE_HEADER.exec(content);
  if (!header) return content.slice(0, proseMaxChars);
  if (content.length <= sourceMaxChars) return content;

  const filePath = header[1]!;
  const chunkStart = Number(header[2]);
  const chunkEnd = Number(header[3]);
  const kept = keepRelevantWindow(content, sourceMaxChars, query);
  const omitted = content.length - kept.length;

  // Map the character cut back to a source line: the content carries a `[Source: …]`
  // header line and an opening fence before the body starts at chunkStart.
  const lastKeptLine = chunkStart + Math.max(0, kept.split("\n").length - 2) - 1;

  let members: Array<{
    qualified_name: string;
    kind: string;
    line_start: number;
    signature: string | null;
  }> = [];
  try {
    members = db
      .query<
        { qualified_name: string; kind: string; line_start: number; signature: string | null },
        [string, number, number]
      >(
        `SELECT s.qualified_name, s.kind, s.line_start, s.signature
           FROM symbols s
           JOIN source_files sf ON s.source_file_id = sf.id
          WHERE sf.file_path = ? AND s.line_start > ? AND s.line_end <= ?
          ORDER BY s.line_start
          LIMIT 40`,
      )
      .all(filePath, lastKeptLine, chunkEnd);
  } catch {
    // Symbol index unavailable — fall through to the plain truncation marker.
  }

  const parts = [kept, `\n… [truncated: ${omitted} chars omitted]`];
  if (members.length > 0) {
    parts.push(`\n[Members of ${filePath}:${chunkStart}-${chunkEnd} below the cut]`);
    for (const m of members) {
      const sig = m.signature ? ` ${m.signature.replace(/\s+/g, " ").trim()}` : "";
      parts.push(`\n- ${m.qualified_name} (${m.kind}, ${filePath}:${m.line_start})${sig}`);
    }
  }
  return parts.join("");
}

/**
 * Extract brief excerpts from content based on query term overlap.
 * Splits content into paragraphs, scores by query term overlap,
 * returns top N in original order.
 */
function extractBriefExcerpts(content: string, query: string, max: number = 3): string[] {
  const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
  if (paragraphs.length <= max) return paragraphs;

  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 2);
  if (queryTerms.length === 0) return paragraphs.slice(0, max);

  const scored = paragraphs.map((p, i) => {
    const lower = p.toLowerCase();
    let score = 0;
    for (const term of queryTerms) {
      if (lower.includes(term)) score++;
    }
    return { paragraph: p, index: i, score };
  });

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, max);
  top.sort((a, b) => a.index - b.index);
  return top.map((t) => t.paragraph);
}

export interface CloseMaintenancePayload {
  narrativeId: string;
  codePath: string | null;
  residualPairs: Array<{ conceptId: string; newChunkId: string; oldChunkId: string | null }>;
  entryConceptPairs: Array<{ entryIndex: number; conceptId: string }>;
}

export async function closeNarrativeOp(
  db: Database,
  lorePath: string,
  narrativeName: string,
  config: LoreConfig,
  embedder: Embedder,
  generator: Generator,
  codePath?: string,
  opts?: {
    /** Called for each non-create/non-update lifecycle target after journal integration. */
    lifecycleTargetHandler?: (target: NarrativeTarget) => Promise<void>;
    mergeStrategy?: MergeStrategy;
    /** Code-specialized embedder for ground_residual computation. Falls back to text embedder if null. */
    codeEmbedder?: Embedder | null;
  },
): Promise<CloseResult> {
  const narrative = getNarrativeByName(db, narrativeName);
  if (!narrative || !isNarrativeClosable(narrative.status)) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }

  const closeSpan = tracer.span("close");
  const debtBefore = getLatestDebt(db);

  // Batch embed journal chunks (deferred from log time for speed)
  const embedSpan = tracer.span("batch-embed-journals");
  const journalChunks = getJournalChunksForNarrative(db, narrative.id);
  const journalEmbeddingsByChunkId = batchLoadEmbeddingsByChunkIds(
    db,
    journalChunks.map((chunk) => chunk.id),
  );
  const unemeddedJournals = journalChunks.filter(
    (chunk) => !journalEmbeddingsByChunkId.has(chunk.id),
  );
  if (unemeddedJournals.length > 0) {
    const journalTexts = await Promise.all(
      unemeddedJournals.map((c) => readChunk(c.file_path).then((p) => p.content)),
    );
    const journalEmbeddings = await embedder.embedBatch(journalTexts);
    insertEmbeddingBatch(
      db,
      unemeddedJournals.map((chunk, index) => ({
        chunkId: chunk.id,
        embedding: journalEmbeddings[index]!,
        model: config.ai.embedding.model,
      })),
    );
    for (let i = 0; i < unemeddedJournals.length; i++) {
      journalEmbeddingsByChunkId.set(unemeddedJournals[i]!.id, journalEmbeddings[i]!);
    }
    await mapConcurrent(unemeddedJournals, 6, async (chunk, index) => {
      await writeEmbeddingFile(
        embeddingFilePath(chunk.file_path),
        config.ai.embedding.model,
        journalEmbeddings[index]!,
      );
    });
  }
  embedSpan.end();

  // Phase transition detection: measure semantic distance between incoming narrative
  // content and existing concept embeddings. High distance signals potential contradiction.
  const PHASE_TRANSITION_THRESHOLD = 0.45;
  const phaseTransitions: PhaseTransitionWarning[] = [];

  try {
    // Get all journal embeddings for this narrative
    const narrativeEmbeddings = journalChunks
      .map((chunk) => journalEmbeddingsByChunkId.get(chunk.id))
      .filter((embedding): embedding is Float32Array => embedding != null);

    if (narrativeEmbeddings.length > 0) {
      const narrativeCentroid = averageVectors(narrativeEmbeddings);

      // Check each declared target concept (if any), or all active concepts if few entries
      const parsedTargets: NarrativeTarget[] = narrative.targets
        ? (JSON.parse(narrative.targets) as NarrativeTarget[])
        : [];
      const targetConceptNames = new Set(
        parsedTargets
          .filter((t) => t.op === "update" || t.op === "create")
          .map((t) => (t as { concept: string }).concept),
      );

      const conceptsToCheck =
        targetConceptNames.size > 0
          ? getActiveConcepts(db).filter((c) => targetConceptNames.has(c.name))
          : getActiveConcepts(db).slice(0, 20); // limit to top-20 when no explicit targets
      const conceptEmbeddingsByChunkId = batchLoadEmbeddingsByChunkIds(
        db,
        conceptsToCheck.map((concept) => concept.active_chunk_id),
      );

      for (const concept of conceptsToCheck) {
        if (!concept.active_chunk_id) continue;
        const conceptEmbedding = conceptEmbeddingsByChunkId.get(concept.active_chunk_id);
        if (!conceptEmbedding) continue;
        const dist = cosineDistance(narrativeCentroid, conceptEmbedding);
        if (dist >= PHASE_TRANSITION_THRESHOLD) {
          const magnitude: PhaseTransitionWarning["magnitude"] =
            dist > 0.75 ? "structural" : dist > 0.6 ? "strong" : "moderate";
          phaseTransitions.push({
            concept_name: concept.name,
            distance: dist,
            magnitude,
            narrative_entry_count: narrativeEmbeddings.length,
          });
        }
      }
    }
  } catch {
    // Best-effort — never block integration on phase transition detection failure
  }

  // Parse declared targets from the narrative record
  const declaredTargets: NarrativeTarget[] = narrative.targets
    ? (JSON.parse(narrative.targets) as NarrativeTarget[])
    : [];
  const allJournalChunks = journalChunks;
  const planSpan = tracer.span("plan-explicit-close");
  const plan = await buildExplicitClosePlan(db, narrative, generator, opts?.mergeStrategy);
  planSpan.end();
  if (plan.unresolvedEntries.length > 0) {
    throw new LoreError(
      "JOURNAL_CONCEPTS_REQUIRED",
      `Narrative '${narrativeName}' has journal entries without valid concept designations. Repair them with 'lore sys narrative designate ${narrativeName} <chunk-id> --concept <name>' before closing.`,
      { unresolved_entries: plan.unresolvedEntries },
    );
  }

  const conceptsUpdated: string[] = [];
  const conceptsCreated: string[] = [];
  const conflicts: MergeConflict[] = [];

  type PreparedChunkWrite = {
    conceptId: string;
    conceptName: string;
    existingChunkId: string | null;
    chunkId: string;
    filePath: string;
    content: string;
    sourceEntryIndices: number[];
  };

  type PreparedConceptIntegration = {
    conceptId: string;
    conceptName: string;
    preparedChunkWrite: PreparedChunkWrite;
    pendingEmbed: { chunkId: string; content: string };
    residualPair: { conceptId: string; newChunkId: string; oldChunkId: string | null };
    conflict: MergeConflict | null;
    createdConcept: { id: string; name: string } | null;
  };

  const preparedConceptCreates: Array<{ id: string; name: string }> = [];
  const preparedChunkWrites: PreparedChunkWrite[] = [];
  let commit: ReturnType<typeof insertCommit> | null = null;
  let queuedMaintenanceJob: { id: string; created_at: string } | null = null;

  // Collect chunk contents + IDs for batch embedding after both loops
  const pendingEmbeds: Array<{ chunkId: string; content: string }> = [];
  // Track old→new chunk pairs for residual computation (Phase 3)
  const residualPairs: Array<{ conceptId: string; newChunkId: string; oldChunkId: string | null }> =
    [];

  // Track entry index → conceptIds for auto-binding symbol_refs during maintenance.
  const entryIndexToConceptIds = new Map<number, Set<string>>();
  const touchedConceptIds = new Set<string>();
  const maintenancePayload = (): CloseMaintenancePayload => ({
    narrativeId: narrative.id,
    codePath: codePath ?? null,
    residualPairs,
    entryConceptPairs: [...entryIndexToConceptIds.entries()].flatMap(([entryIndex, conceptIds]) =>
      [...conceptIds].map((conceptId) => ({ entryIndex, conceptId })),
    ),
  });

  // Get merge base and head trees for 3-way merge
  const mergeBaseId = narrative.merge_base_commit_id;
  const head = getHeadCommit(db);
  const baseTree = mergeBaseId ? getCommitTreeAsMap(db, mergeBaseId) : new Map<string, string>();
  const headTree = head ? getCommitTreeAsMap(db, head.id) : new Map<string, string>();

  const activeConceptsBefore = getActiveConcepts(db);
  const activeConceptsById = new Map(activeConceptsBefore.map((concept) => [concept.id, concept]));
  const activeConceptsByName = new Map(
    activeConceptsBefore.map((concept) => [concept.name, concept]),
  );

  const relevantChunkIds = new Set<string>();
  for (const update of plan.updates) {
    const concept = activeConceptsById.get(update.conceptId) ?? getConcept(db, update.conceptId);
    if (concept?.active_chunk_id) {
      relevantChunkIds.add(concept.active_chunk_id);
    }
    const baseChunkId = baseTree.get(update.conceptId);
    if (baseChunkId) relevantChunkIds.add(baseChunkId);
    const headChunkId = headTree.get(update.conceptId);
    if (headChunkId) relevantChunkIds.add(headChunkId);
  }
  for (const create of plan.creates) {
    const existingConcept =
      activeConceptsByName.get(create.conceptName) ?? getConceptByName(db, create.conceptName);
    if (existingConcept?.active_chunk_id) {
      relevantChunkIds.add(existingConcept.active_chunk_id);
    }
  }
  const chunkRowsById = batchLoadChunksByIds(db, [...relevantChunkIds]);
  const parsedChunksById = await batchReadParsedChunksByIds(chunkRowsById, [...relevantChunkIds]);

  // Apply updates — 3-way merge when needed
  const preparedUpdates = await mapConcurrent(
    plan.updates,
    4,
    async (update): Promise<PreparedConceptIntegration | null> => {
      const concept = activeConceptsById.get(update.conceptId) ?? getConcept(db, update.conceptId);
      if (!concept) return null;

      const baseChunkId = baseTree.get(update.conceptId);
      const headChunkId = headTree.get(update.conceptId);

      let finalContent = update.newContent;
      let conflict: MergeConflict | null = null;

      // Detect conflict: concept changed on main while narrative was open
      if (baseChunkId && headChunkId && baseChunkId !== headChunkId) {
        const baseContent = parsedChunksById.get(baseChunkId)?.content ?? null;
        const headContent = parsedChunksById.get(headChunkId)?.content ?? "";

        const resolved = await generator.threeWayMerge(
          update.conceptName,
          baseContent,
          headContent,
          update.newContent,
        );
        finalContent = resolved;
        conflict = {
          conceptId: update.conceptId,
          conceptName: update.conceptName,
          baseContent,
          headContent,
          narrativeContent: update.newContent,
          resolution: "auto-merged",
          resolvedContent: resolved,
        };
      }

      const currentParsed = concept.active_chunk_id
        ? (parsedChunksById.get(concept.active_chunk_id) ?? null)
        : null;
      const oldContent = currentParsed?.content ?? null;
      const currentVersion =
        currentParsed && "fl_version" in currentParsed.frontmatter
          ? ((currentParsed.frontmatter as { fl_version: number }).fl_version ?? 0)
          : 0;
      const nextVersion = currentVersion + 1;

      const { id, filePath } = await writeStateChunk({
        lorePath,
        concept: update.conceptName,
        conceptId: update.conceptId,
        narrativeOrigin: narrativeName,
        version: nextVersion,
        supersedes: update.existingChunkId,
        content: finalContent,
      });

      return {
        conceptId: update.conceptId,
        conceptName: update.conceptName,
        preparedChunkWrite: {
          conceptId: update.conceptId,
          conceptName: update.conceptName,
          existingChunkId: update.existingChunkId,
          chunkId: id,
          filePath,
          content: finalContent,
          sourceEntryIndices: update.sourceEntryIndices,
        },
        pendingEmbed: { chunkId: id, content: finalContent },
        residualPair: {
          conceptId: update.conceptId,
          newChunkId: id,
          oldChunkId: update.existingChunkId,
        },
        conflict,
        createdConcept: null,
      };
    },
  );
  for (const prepared of preparedUpdates) {
    if (!prepared) continue;
    preparedChunkWrites.push(prepared.preparedChunkWrite);
    pendingEmbeds.push(prepared.pendingEmbed);
    residualPairs.push(prepared.residualPair);
    if (prepared.conflict) {
      conflicts.push(prepared.conflict);
    }
    for (const idx of prepared.preparedChunkWrite.sourceEntryIndices) {
      const ids = entryIndexToConceptIds.get(idx) ?? new Set<string>();
      ids.add(prepared.conceptId);
      entryIndexToConceptIds.set(idx, ids);
    }
    touchedConceptIds.add(prepared.conceptId);
    conceptsUpdated.push(prepared.conceptName);
  }

  // Create new concepts — check for concurrent creates
  const preparedCreates = await mapConcurrent(
    plan.creates,
    4,
    async (create): Promise<PreparedConceptIntegration> => {
      const existingConcept =
        activeConceptsByName.get(create.conceptName) ?? getConceptByName(db, create.conceptName);

      let finalContent = create.content;
      let conceptId: string;
      let conflict: MergeConflict | null = null;
      let createdConcept: { id: string; name: string } | null = null;

      if (existingConcept && !baseTree.has(existingConcept.id)) {
        // Concurrent create — concept exists now but didn't at merge base
        conceptId = existingConcept.id;
        if (existingConcept.active_chunk_id) {
          const headContent = parsedChunksById.get(existingConcept.active_chunk_id)?.content ?? "";

          const resolved = await generator.threeWayMerge(
            create.conceptName,
            null,
            headContent,
            create.content,
          );
          finalContent = resolved;
          conflict = {
            conceptId,
            conceptName: create.conceptName,
            baseContent: null,
            headContent,
            narrativeContent: create.content,
            resolution: "auto-merged",
            resolvedContent: resolved,
          };
        }
      } else if (existingConcept) {
        // Concept already existed — treat as update
        conceptId = existingConcept.id;
      } else {
        conceptId = ulid();
        createdConcept = { id: conceptId, name: create.conceptName };
      }

      const currentParsed = existingConcept?.active_chunk_id
        ? (parsedChunksById.get(existingConcept.active_chunk_id) ?? null)
        : null;
      const currentVersion =
        currentParsed && "fl_version" in currentParsed.frontmatter
          ? ((currentParsed.frontmatter as { fl_version: number }).fl_version ?? 0)
          : 0;
      const nextVersion = currentVersion + 1;

      const { id, filePath } = await writeStateChunk({
        lorePath,
        concept: create.conceptName,
        conceptId,
        narrativeOrigin: narrativeName,
        version: nextVersion,
        content: finalContent,
      });

      return {
        conceptId,
        conceptName: create.conceptName,
        preparedChunkWrite: {
          conceptId,
          conceptName: create.conceptName,
          existingChunkId: null,
          chunkId: id,
          filePath,
          content: finalContent,
          sourceEntryIndices: create.sourceEntryIndices,
        },
        pendingEmbed: { chunkId: id, content: finalContent },
        residualPair: { conceptId, newChunkId: id, oldChunkId: null },
        conflict,
        createdConcept,
      };
    },
  );
  for (const prepared of preparedCreates) {
    if (prepared.createdConcept) {
      preparedConceptCreates.push(prepared.createdConcept);
    }
    preparedChunkWrites.push(prepared.preparedChunkWrite);
    pendingEmbeds.push(prepared.pendingEmbed);
    residualPairs.push(prepared.residualPair);
    if (prepared.conflict) {
      conflicts.push(prepared.conflict);
    }
    for (const idx of prepared.preparedChunkWrite.sourceEntryIndices) {
      const ids = entryIndexToConceptIds.get(idx) ?? new Set<string>();
      ids.add(prepared.conceptId);
      entryIndexToConceptIds.set(idx, ids);
    }
    touchedConceptIds.add(prepared.conceptId);
    conceptsCreated.push(prepared.conceptName);
  }

  // Batch embed all new state chunks
  const stateEmbedSpan = tracer.span("batch-embed-state");
  const embeddingByChunkId = new Map<string, Float32Array>();
  const frontmatterUpdatesByPath = new Map<string, Record<string, unknown>>();
  let embeddedAt: string | null = null;
  if (pendingEmbeds.length > 0) {
    const embeddings = await embedder.embedBatch(pendingEmbeds.map((p) => p.content));
    for (let i = 0; i < pendingEmbeds.length; i++) {
      embeddingByChunkId.set(pendingEmbeds[i]!.chunkId, embeddings[i]!);
    }
    embeddedAt = new Date().toISOString();
  }

  try {
    db.run("BEGIN IMMEDIATE TRANSACTION");
    insertConceptRawBatch(
      db,
      preparedConceptCreates.map((concept) => ({
        id: concept.id,
        name: concept.name,
        opts: { activeChunkId: null },
      })),
    );
    const chunkCreatedAt = new Date().toISOString();
    insertChunkBatch(
      db,
      preparedChunkWrites.map((chunk) => ({
        id: chunk.chunkId,
        filePath: chunk.filePath,
        flType: "chunk",
        conceptId: chunk.conceptId,
        narrativeId: narrative.id,
        supersedesId: chunk.existingChunkId,
        createdAt: chunkCreatedAt,
      })),
    );
    insertFtsContentBatch(
      db,
      preparedChunkWrites.map((chunk) => ({ content: chunk.content, chunkId: chunk.chunkId })),
    );
    insertEmbeddingBatch(
      db,
      preparedChunkWrites
        .map((chunk) => {
          const embedding = embeddingByChunkId.get(chunk.chunkId);
          return embedding
            ? { chunkId: chunk.chunkId, embedding, model: config.ai.embedding.model }
            : null;
        })
        .filter(
          (item): item is { chunkId: string; embedding: Float32Array; model: string } =>
            item != null,
        ),
    );
    insertConceptVersionBatch(
      db,
      preparedChunkWrites.map((chunk) => ({
        id: chunk.conceptId,
        fields: { active_chunk_id: chunk.chunkId, staleness: 0 },
      })),
    );
    markLanceDirty(db);
    const treeEntries: Array<{ conceptId: string; chunkId: string; conceptName: string }> = [];
    for (const concept of getConcepts(db)) {
      if (
        concept.active_chunk_id &&
        (concept.lifecycle_status == null || concept.lifecycle_status === "active")
      ) {
        treeEntries.push({
          conceptId: concept.id,
          chunkId: concept.active_chunk_id,
          conceptName: concept.name,
        });
      }
    }
    const parentId = head?.id ?? null;
    const commitMessage = `close narrative '${narrativeName}': ${conceptsUpdated.length} updated, ${conceptsCreated.length} created`;
    commit = insertCommit(db, narrative.id, parentId, mergeBaseId, commitMessage);
    insertCommitTree(db, commit.id, treeEntries);
    closeDbNarrative(db, narrative.id);
    if (touchedConceptIds.size > 0) {
      queuedMaintenanceJob = queueCloseMaintenanceJob(db, {
        lorePath,
        narrativeId: narrative.id,
        narrativeName,
        commitId: commit.id,
        payload: maintenancePayload(),
      });
    }
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {}
    throw error;
  }

  const supersededChunkRows = batchLoadChunksByIds(
    db,
    preparedChunkWrites
      .map((chunk) => chunk.existingChunkId)
      .filter((chunkId): chunkId is string => !!chunkId),
  );
  for (const chunk of preparedChunkWrites) {
    if (chunk.existingChunkId) {
      const oldChunk = supersededChunkRows.get(chunk.existingChunkId);
      if (oldChunk) {
        mergeFrontmatterUpdates(frontmatterUpdatesByPath, oldChunk.file_path, {
          fl_superseded_by: chunk.chunkId,
        });
      }
    }
    if (embeddedAt && embeddingByChunkId.has(chunk.chunkId)) {
      mergeFrontmatterUpdates(frontmatterUpdatesByPath, chunk.filePath, {
        fl_embedding_model: config.ai.embedding.model,
        fl_embedded_at: embeddedAt,
      });
    }
  }
  await mapConcurrent(preparedChunkWrites, 6, async (chunk) => {
    try {
      if (embeddedAt && embeddingByChunkId.has(chunk.chunkId)) {
        await writeEmbeddingFile(
          embeddingFilePath(chunk.filePath),
          config.ai.embedding.model,
          embeddingByChunkId.get(chunk.chunkId)!,
        );
      }
    } catch {
      // Best-effort metadata updates must not invalidate an already committed close.
    }
  });
  stateEmbedSpan.end();

  if (!commit) {
    throw new LoreError(
      "COMMIT_NOT_FOUND",
      `Close commit for narrative '${narrativeName}' was not created`,
    );
  }

  // Execute lifecycle targets (rename, archive, restore, merge, split)
  const lifecycleTargets = declaredTargets.filter((t) => t.op !== "create" && t.op !== "update");
  if (lifecycleTargets.length > 0 && opts?.lifecycleTargetHandler) {
    for (const target of lifecycleTargets) {
      await opts.lifecycleTargetHandler(target);
    }
  }

  let maintenance: CloseResult["maintenance"] | undefined;
  if (queuedMaintenanceJob) {
    const jobCounts = getCloseMaintenanceJobCounts(db, { lorePath });
    maintenance = {
      status: "queued",
      job_id: queuedMaintenanceJob.id,
      pending_jobs: jobCounts.queued + jobCounts.leased,
      failed_jobs: jobCounts.failed,
      note: "Residuals, bindings, and graph refresh were queued after the authoritative merge.",
    };
  }

  const manifestBeforeUpdate = getManifest(db);
  upsertManifest(db, {
    chunk_count: getChunkCount(db),
    concept_count: getActiveConceptCount(db),
    last_integrated: new Date().toISOString(),
    debt: manifestBeforeUpdate?.debt ?? debtBefore,
    debt_trend: manifestBeforeUpdate?.debt_trend ?? "stable",
    graph_stale: maintenance ? 1 : (manifestBeforeUpdate?.graph_stale ?? 0),
  });

  let followUp: string | undefined;
  if (phaseTransitions.some((transition) => transition.magnitude !== "moderate")) {
    const names = phaseTransitions
      .filter((transition) => transition.magnitude !== "moderate")
      .map((transition) => transition.concept_name);
    followUp = `Review phase-transition concepts: ${names.join(", ")}`;
  }
  if (conflicts.length > 0) {
    const conflictNote = `${conflicts.length} merge conflict(s) auto-resolved`;
    followUp = followUp ? `${followUp}. ${conflictNote}` : conflictNote;
  }
  if (maintenance?.note) {
    followUp = followUp ? `${followUp}. ${maintenance.note}` : maintenance.note;
  }

  const debtAfter = maintenance ? null : (getManifest(db)?.debt ?? debtBefore);

  closeSpan.end();
  const traceSummary = tracer.summary();
  if (traceSummary) console.error(traceSummary);
  tracer.reset();

  return {
    mode: "merge",
    integrated: true,
    commit_id: commit.id,
    narrative_status: "closed",
    concepts_updated: conceptsUpdated,
    concepts_created: conceptsCreated,
    conflicts,
    impact: {
      summary: maintenance
        ? "Authoritative merge committed. Maintenance was queued for residuals, bindings, and graph refresh."
        : `Debt ${debtAfter! < debtBefore ? "reduced" : "increased"} ${Math.abs(((debtBefore - debtAfter!) / (debtBefore || 1)) * 100).toFixed(0)}%.`,
      debt_before: debtBefore,
      debt_after: debtAfter,
    },
    maintenance,
    follow_up: followUp,
    phase_transitions: phaseTransitions.length > 0 ? phaseTransitions : undefined,
  };
}

export async function runCloseMaintenanceJob(
  db: Database,
  payload: CloseMaintenancePayload,
  config: LoreConfig,
  embedder: Embedder,
  generator: Generator,
  codeEmbedder?: Embedder | null,
): Promise<{ rescanFailed: string[] }> {
  if (payload.residualPairs.length === 0) {
    upsertManifest(db, {
      chunk_count: getChunkCount(db),
      concept_count: getActiveConceptCount(db),
      graph_stale: 0,
      last_integrated: new Date().toISOString(),
    });
    return { rescanFailed: [] };
  }

  let rescanFailed: string[] = [];
  const debtBefore = getManifest(db)?.debt ?? getLatestDebt(db);
  const residualPairByConceptId = new Map(
    payload.residualPairs.map((pair) => [pair.conceptId, pair] as const),
  );
  const residualConceptIds = [...new Set(payload.residualPairs.map((pair) => pair.conceptId))];
  const newChunkRows = batchLoadChunksByIds(
    db,
    payload.residualPairs.map((pair) => pair.newChunkId),
  );
  const newParsedChunks = await batchReadParsedChunksByIds(
    newChunkRows,
    payload.residualPairs.map((pair) => pair.newChunkId),
  );
  const newEmbeddingsByChunkId = batchLoadEmbeddingsByChunkIds(
    db,
    payload.residualPairs.map((pair) => pair.newChunkId),
  );
  const oldEmbeddingsByChunkId = batchLoadEmbeddingsByChunkIds(
    db,
    payload.residualPairs.map((pair) => pair.oldChunkId),
  );
  const contentByChunkId = new Map<string, string>();
  for (const [chunkId, parsed] of newParsedChunks.entries()) {
    contentByChunkId.set(chunkId, parsed.content);
  }

  const frontmatterUpdatesByPath = new Map<string, Record<string, unknown>>();
  const symbolLinesByConceptId = payload.codePath
    ? batchLoadSymbolLinesByConceptIds(db, residualConceptIds)
    : new Map<string, ConceptSymbolLineRange[]>();
  const symbolReadTargets = new Map<
    string,
    { file_path: string; line_start: number; line_end: number }
  >();
  if (payload.codePath) {
    for (const symbolLines of symbolLinesByConceptId.values()) {
      for (const sym of symbolLines) {
        if (!symbolReadTargets.has(sym.symbol_id)) {
          symbolReadTargets.set(sym.symbol_id, {
            file_path: sym.file_path,
            line_start: sym.line_start,
            line_end: sym.line_end,
          });
        }
      }
    }
  }

  const symbolContentById = new Map<string, string>();
  if (payload.codePath && symbolReadTargets.size > 0) {
    const symbolReads = await mapConcurrent(
      [...symbolReadTargets.entries()],
      8,
      async ([symbolId, target]) => ({
        symbolId,
        content: await readSymbolContent(
          payload.codePath!,
          target.file_path,
          target.line_start,
          target.line_end,
        ),
      }),
    );
    for (const read of symbolReads) {
      if (read.content) {
        symbolContentById.set(read.symbolId, read.content);
      }
    }
  }

  const symbolContentEntries = [...symbolContentById.entries()].map(([symbolId, content]) => ({
    symbolId,
    content,
  }));
  const conceptCodeEmbeddingsByConceptId = new Map<string, Float32Array>();
  const symbolCodeEmbeddingsById = new Map<string, Float32Array>();
  const symbolTextEmbeddingsById = new Map<string, Float32Array>();

  if (codeEmbedder && config.ai.embedding.code?.model && payload.codePath) {
    const codeModel = config.ai.embedding.code.model;
    try {
      const conceptCodeTargets = residualConceptIds
        .map((conceptId) => {
          const pair = residualPairByConceptId.get(conceptId);
          if (!pair) return null;
          const content = contentByChunkId.get(pair.newChunkId);
          if (!content) return null;
          return { conceptId, content };
        })
        .filter((target): target is { conceptId: string; content: string } => target != null);

      if (conceptCodeTargets.length > 0 || symbolContentEntries.length > 0) {
        const codeEmbeddings = await codeEmbedder.embedBatch([
          ...conceptCodeTargets.map((target) => target.content),
          ...symbolContentEntries.map((entry) => entry.content),
        ]);
        for (let i = 0; i < conceptCodeTargets.length; i++) {
          conceptCodeEmbeddingsByConceptId.set(
            conceptCodeTargets[i]!.conceptId,
            codeEmbeddings[i]!,
          );
        }
        const symbolOffset = conceptCodeTargets.length;
        const symbolEmbeddingWrites: Array<{
          symbolId: string;
          embedding: Float32Array;
          model: string;
        }> = [];
        for (let i = 0; i < symbolContentEntries.length; i++) {
          const embedding = codeEmbeddings[symbolOffset + i]!;
          symbolCodeEmbeddingsById.set(symbolContentEntries[i]!.symbolId, embedding);
          symbolEmbeddingWrites.push({
            symbolId: symbolContentEntries[i]!.symbolId,
            embedding,
            model: codeModel,
          });
        }
        if (symbolEmbeddingWrites.length > 0) {
          insertSymbolEmbeddingBatch(db, symbolEmbeddingWrites);
        }
      }
    } catch {
      // Non-fatal: residuals can still fall back to text embeddings/churn.
    }
  }

  if (
    payload.codePath &&
    symbolContentEntries.length > 0 &&
    (!codeEmbedder ||
      residualConceptIds.some((conceptId) => !conceptCodeEmbeddingsByConceptId.has(conceptId)))
  ) {
    try {
      const symbolTextEmbeddings = await embedder.embedBatch(
        symbolContentEntries.map((entry) => entry.content),
      );
      for (let i = 0; i < symbolContentEntries.length; i++) {
        symbolTextEmbeddingsById.set(symbolContentEntries[i]!.symbolId, symbolTextEmbeddings[i]!);
      }
    } catch {
      // Non-fatal.
    }
  }

  const residualConceptUpdates: Array<{
    id: string;
    fields: { churn: number; ground_residual: number | null };
  }> = [];
  const conceptsBeforeResidualsById = new Map(
    getConcepts(db).map((concept) => [concept.id, concept]),
  );
  for (const pair of payload.residualPairs) {
    const newEmb = newEmbeddingsByChunkId.get(pair.newChunkId);
    let churn = 0;
    if (pair.oldChunkId && newEmb) {
      const oldEmb = oldEmbeddingsByChunkId.get(pair.oldChunkId);
      if (oldEmb) {
        churn = cosineDistance(oldEmb, newEmb);
      }
    }

    let groundResidual: number | null = null;
    if (payload.codePath) {
      const symbolLines = symbolLinesByConceptId.get(pair.conceptId) ?? [];
      const codeGrounding = symbolLines
        .map((sym) => {
          const embedding = symbolCodeEmbeddingsById.get(sym.symbol_id);
          return embedding ? { embedding, confidence: sym.confidence } : null;
        })
        .filter((item): item is { embedding: Float32Array; confidence: number } => item != null);
      const conceptCodeEmbedding = conceptCodeEmbeddingsByConceptId.get(pair.conceptId);
      if (conceptCodeEmbedding && codeGrounding.length > 0) {
        groundResidual = cosineDistance(
          conceptCodeEmbedding,
          weightedAverageVectors(
            codeGrounding.map((item) => item.embedding),
            codeGrounding.map((item) => item.confidence),
          ),
        );
      } else if (newEmb) {
        const textGrounding = symbolLines
          .map((sym) => {
            const embedding = symbolTextEmbeddingsById.get(sym.symbol_id);
            return embedding ? { embedding, confidence: sym.confidence } : null;
          })
          .filter((item): item is { embedding: Float32Array; confidence: number } => item != null);
        if (textGrounding.length > 0) {
          groundResidual = cosineDistance(
            newEmb,
            weightedAverageVectors(
              textGrounding.map((item) => item.embedding),
              textGrounding.map((item) => item.confidence),
            ),
          );
        }
      }
    }
    // When e_embed cannot be measured (no code path, no bound symbols, no
    // embeddings) it stays null. Churn — how much the prose moved between
    // versions — is a change rate, not an error estimate, and used to be
    // written here as ground_residual, where debt read it as evidence that the
    // prose was WRONG. A null is a measurement gap and is surfaced as one.

    residualConceptUpdates.push({
      id: pair.conceptId,
      fields: { churn, ground_residual: groundResidual },
    });
    const chunkRow = newChunkRows.get(pair.newChunkId);
    if (chunkRow) {
      mergeFrontmatterUpdates(frontmatterUpdatesByPath, chunkRow.file_path, {
        fl_staleness: 0,
      });
    }
  }
  insertConceptVersionBatch(db, residualConceptUpdates, conceptsBeforeResidualsById);

  if (residualConceptIds.length > 0) {
    await discoverConcepts(db, generator);
  }

  if (payload.codePath && residualConceptIds.length > 0) {
    const filePaths = new Set<string>();
    for (const conceptId of residualConceptIds) {
      for (const filePath of getFilesForConcept(db, conceptId)) {
        filePaths.add(filePath);
      }
    }
    if (filePaths.size > 0) {
      const { filesFailed } = await rescanFiles(db, payload.codePath, [...filePaths]);
      rescanFailed = filesFailed;
    }
    await extractBindingsForConcepts(db, residualConceptIds);
    await autoBindByFileOverlap(db, { conceptIds: residualConceptIds });
    pruneOrphanedBindings(db);
  }

  const entryConceptIds = new Map<number, Set<string>>();
  for (const pair of payload.entryConceptPairs) {
    const ids = entryConceptIds.get(pair.entryIndex) ?? new Set<string>();
    ids.add(pair.conceptId);
    entryConceptIds.set(pair.entryIndex, ids);
  }
  const allJournalChunks = getJournalChunksForNarrative(db, payload.narrativeId);
  const autoBindPairs = new Map<string, { conceptId: string; symbolId: string }>();
  for (let i = 0; i < allJournalChunks.length; i++) {
    const chunk = allJournalChunks[i]!;
    if (!chunk.symbol_refs) continue;
    const conceptIds = [...(entryConceptIds.get(i) ?? new Set<string>())];
    if (conceptIds.length === 0) continue;
    const symbolIds: string[] = JSON.parse(chunk.symbol_refs);
    for (const conceptId of conceptIds) {
      for (const symbolId of symbolIds) {
        autoBindPairs.set(`${conceptId}:${symbolId}`, { conceptId, symbolId });
      }
    }
  }
  const symbolBodyHashes = batchLoadSymbolBodyHashesByIds(db, [
    ...new Set([...autoBindPairs.values()].map((pair) => pair.symbolId)),
  ]);
  for (const pair of autoBindPairs.values()) {
    try {
      upsertConceptSymbol(db, {
        conceptId: pair.conceptId,
        symbolId: pair.symbolId,
        bindingType: "mention",
        boundBodyHash: symbolBodyHashes.get(pair.symbolId) ?? null,
        confidence: 0.6,
      });
    } catch {
      // Non-fatal.
    }
  }

  // Drift is NOT ratcheted into staleness or ground_residual here
  // (knowledge-model spec rule 3: a composite is never stored into a
  // component). Drift lives in exactly one place — the drifted-binding rows —
  // and debt/staleness read it as the e_drift ratio at read time. The old
  // ratchet double-counted every drift event (staleness, ground_residual and
  // residual all moved) and could never be un-ratcheted when the drift healed.

  // The `residual` column is the R(c) cache (spec §9.2): refreshed from the
  // axes now that bindings have settled, so ls/show and residual_history see
  // the same number debt does. Nothing else may write it.
  const activeBeforeCache = getActiveConcepts(db);
  const expectedAfter = computeExpectedDebt(db, activeBeforeCache);
  const residualCacheUpdates = activeBeforeCache.flatMap((concept) => {
    const g = expectedAfter.residuals.get(concept.id);
    if (!g || (concept.residual != null && Math.abs(concept.residual - g.residual) < 1e-9)) {
      return [];
    }
    return [{ id: concept.id, fields: { residual: g.residual } }];
  });
  insertConceptVersionBatch(
    db,
    residualCacheUpdates,
    new Map(getConcepts(db).map((concept) => [concept.id, concept])),
  );

  const conceptsPost = getConcepts(db);
  const activeConceptsPost = getActiveConcepts(db);
  const debtAfter = expectedAfter.debt ?? 0;
  recordResiduals(db, activeConceptsPost, debtAfter);

  // Frontmatter mirrors for the concepts this close touched plus any whose
  // R(c) is high enough to be acted on — best-effort metadata only.
  const scopedConcepts = new Set<string>(residualConceptIds);
  for (const [conceptId, g] of expectedAfter.residuals) {
    if (g.residual > 0.3) scopedConcepts.add(conceptId);
  }
  const conceptsPostChunkRows = batchLoadChunksByIds(
    db,
    conceptsPost
      .filter((concept) => scopedConcepts.has(concept.id) && concept.active_chunk_id)
      .map((concept) => concept.active_chunk_id!),
  );
  for (const concept of conceptsPost) {
    if (!scopedConcepts.has(concept.id)) continue;
    const chunkId = concept.active_chunk_id;
    if (!chunkId) continue;
    const chunkRow = conceptsPostChunkRows.get(chunkId);
    if (chunkRow) {
      mergeFrontmatterUpdates(frontmatterUpdatesByPath, chunkRow.file_path, {
        fl_cluster: concept.cluster ?? null,
        fl_residual: expectedAfter.residuals.get(concept.id)?.residual ?? concept.residual ?? null,
      });
    }
  }

  await mapConcurrent([...frontmatterUpdatesByPath.entries()], 6, async ([filePath, updates]) => {
    try {
      await updateChunkFrontmatter(filePath, updates);
    } catch {
      // Best-effort metadata updates must not invalidate an already committed close.
    }
  });

  const debtTrend = computeDebtTrend(debtAfter, debtBefore);
  upsertManifest(db, {
    chunk_count: getChunkCount(db),
    concept_count: getActiveConceptCount(db),
    debt: debtAfter,
    debt_trend: debtTrend,
    last_integrated: new Date().toISOString(),
    graph_stale: 0,
  });
  return { rescanFailed };
}

export function discardNarrative(db: Database, narrativeName: string): CloseResult {
  const narrative = getNarrativeByName(db, narrativeName);
  if (!narrative) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }
  if (narrative.status === "closing") {
    throw new LoreError(
      "NARRATIVE_CLOSING",
      `Narrative '${narrativeName}' is currently closing and cannot be discarded`,
    );
  }
  if (!isNarrativeWritable(narrative.status)) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }
  abandonDbNarrative(db, narrative.id);
  return {
    mode: "discard",
    integrated: false,
    commit_id: null,
    narrative_status: "abandoned",
    concepts_updated: [],
    concepts_created: [],
    conflicts: [],
    impact: {
      summary: `Narrative '${narrativeName}' discarded. ${narrative.entry_count} journal entries preserved on disk.`,
      debt_before: 0,
      debt_after: 0,
    },
  };
}
