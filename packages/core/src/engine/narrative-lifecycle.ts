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
} from "@/types/index.ts";
import {
  insertNarrative,
  getOpenNarrativeByName,
  getOpenNarratives,
  getDanglingNarratives,
  closeNarrative as closeDbNarrative,
  abandonNarrative as abandonDbNarrative,
  updateNarrativeMetrics,
  getConcepts,
  getActiveConcepts,
  getActiveConceptByName,
  getManifest,
  upsertManifest,
  insertChunk,
  insertEmbedding,
  insertFtsContent,
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
  getSymbolLinesForConcept,
  getLastNarrativeForConcept,
  insertSymbolEmbedding,
} from "@/db/index.ts";
import { insertConceptVersion, insertConceptRaw, getConceptByName, getConceptsByCluster } from "@/db/concepts.ts";
import {
  writeStateChunk,
  writeJournalChunk,
  markSuperseded as markSupersededOnDisk,
  updateChunkFrontmatter,
  writeEmbeddingFile,
  embeddingFilePath,
} from "@/storage/index.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { hybridSearch } from "./search.ts";
import type { HybridSearchResult } from "./search.ts";
import { webSearch } from "./web-search.ts";
import { cosineDistance, averageVectors, weightedAverageVectors } from "./residuals.ts";
import { analyzeJournal } from "./integration.ts";
import type { IntegrationPlan } from "./integration.ts";
import { discoverConcepts } from "./concept-discovery.ts";
import {
  computeTotalDebt,
  computeDebtTrend,
  recordResiduals,
  computeStaleness,
  conceptPressureBase,
} from "./residuals.ts";
import { readSymbolContent } from "./git.ts";
import {
  getDriftedBindings,
  getBindingsForConcept,
  getBindingSummariesForConcept,
  getCoverageStats,
  upsertConceptSymbol,
} from "@/db/concept-symbols.ts";
import type { ConceptSymbolLineRange } from "@/db/concept-symbols.ts";
import { getConceptRelations, get2HopNeighbors } from "@/db/concept-relations.ts";
import { rescanFiles } from "./scanner.ts";
import { extractBindingsForConcepts, pruneOrphanedBindings, autoBindByFileOverlap } from "./binding-extraction.ts";
import type { FileRef, SymbolSearchResult } from "@/types/index.ts";
import type { Embedder } from "./embedder.ts";
import type { Generator } from "./generator.ts";
import { rerankResults } from "./reranker.ts";
import { tracer } from "./tracer.ts";
import type { AskTracer } from "./tracer.ts";
import { computeLineDiff, isDiffTooLarge } from "./line-diff.ts";
import { searchSymbols, getSymbolByQualifiedName } from "@/db/symbols.ts";
import { getConceptsForSymbols } from "@/db/concept-symbols.ts";
import { getCallSitesForCallee, getCallSitesByCaller } from "@/db/call-sites.ts";
import { enrichSymbolResults } from "./symbol-search.ts";
import { buildCallGraphAdjacency, personalizedPageRank } from "./graph-expansion.ts";
import {
  askDebtBandWarning,
  askDebtRetrievalMultiplier,
  askDebtStalenessPenaltyMultiplier,
  type AskDebtBand,
} from "./ask-debt.ts";

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

export async function openNarrative(
  db: Database,
  lorePath: string,
  narrativeName: string,
  intent: string,
  config: LoreConfig,
  embedder: Embedder,
  resolveDangling?: ResolveDangling,
  targets?: NarrativeTarget[],
): Promise<OpenResult> {
  // Check for existing open narrative with same name
  const existing = getOpenNarrativeByName(db, narrativeName);
  if (existing) {
    throw new LoreError("NARRATIVE_ALREADY_OPEN", `Narrative '${narrativeName}' is already open`);
  }

  // Check for dangling narratives
  const dangling = getDanglingNarratives(db, config.thresholds.dangling_days);
  if (dangling.length > 0 && !resolveDangling) {
    throw new LoreError("DANGLING_NARRATIVE", `Dangling narrative(s) detected`, {
      narratives: dangling.map((d) => ({
        name: d.name,
        age_days: Math.floor(
          (Date.now() - new Date(d.opened_at).getTime()) / (24 * 60 * 60 * 1000),
        ),
      })),
    });
  }

  // Handle dangling resolution
  if (resolveDangling) {
    const danglingNarrative = getOpenNarrativeByName(db, resolveDangling.narrative);
    if (danglingNarrative) {
      switch (resolveDangling.action) {
        case "abandon":
          abandonDbNarrative(db, danglingNarrative.id);
          break;
        case "resume":
          // Return context for the existing narrative instead
          return buildOpenResult(db, config, embedder, intent);
        default:
          throw new LoreError(
            "DANGLING_NARRATIVE",
            `Unsupported dangling narrative action '${String(resolveDangling.action)}'`,
          );
      }
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
  // Search for relevant context based on intent
  const { results } = await hybridSearch(db, embedder, intent, config, {
    sourceType: "chunk",
    limit: 5,
    textModel: config.ai.embedding.model,
  });

  const readNow = results.map((r) => ({
    file: r.concept ?? "unknown",
    summary: r.content.slice(0, 200),
    priority: (r.score > 0.3 ? "high" : "medium") as "high" | "medium" | "low",
    warning: r.warning,
  }));

  // Check for overlapping narratives
  const headsUp: string[] = [];
  const openNarratives = getOpenNarratives(db);
  for (const narrative of openNarratives) {
    headsUp.push(`Narrative '${narrative.name}' is currently open (opened ${timeAgo(narrative.opened_at)})`);
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

/**
 * Deterministic deep-research heuristic for observability only.
 * This does not alter retrieval behavior; it labels path/chain style queries.
 */
function isLikelyDeepResearchQuery(text: string): boolean {
  const q = text.toLowerCase();
  if (
    /\b(call graph|call chain|callchain|multi[- ]hop|upstream|downstream|end[- ]to[- ]end|e2e)\b/.test(
      q,
    )
  ) {
    return true;
  }
  if (/\b(path|chain|through|across|between|bridge|flow)\b/.test(q)) {
    return true;
  }
  if (/\b(how|why)\b[\s\S]{0,80}\b(from|to|reach|lead|propagate)\b/.test(q)) {
    return true;
  }
  return false;
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
  const narrative = getOpenNarrativeByName(db, narrativeName);
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

  // Resolve concept names → IDs
  const resolvedConceptIds: string[] = [];
  if (concepts && concepts.length > 0) {
    for (const name of concepts) {
      const concept = getActiveConceptByName(db, name);
      if (concept) {
        resolvedConceptIds.push(concept.id);
      }
      // If not found, concept may be created at close time — skip silently
    }
  }

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
  const effectiveTopics =
    topics.length === 0 && concepts && concepts.length > 0 ? [...concepts] : topics;

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
    conceptRefs: resolvedConceptIds.length > 0 ? resolvedConceptIds : null,
    symbolRefs: resolvedSymbolIds.length > 0 ? resolvedSymbolIds : null,
    fileRefs: refs && refs.length > 0 ? refs : null,
  });

  // FTS indexed now so query() can find via BM25; embedding added at close time
  insertFtsContent(db, text, id);

  // Update narrative entry count
  updateNarrativeMetrics(db, narrative.id, {
    theta: null,
    magnitude: null,
    convergence: null,
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
    };
    onProgress?: (message: string) => void;
    /** Code-specialized embedder for a second vector search lane */
    codeEmbedder?: Embedder | null;
    /** "code" injects bound symbol bodies alongside concept prose. "arch" returns prose only. */
    mode?: "arch" | "code";
    /** Ask-pipeline trace logger — logs all queryConcepts stages when provided */
    tracer?: AskTracer;
    ask_debt?: {
      score: number;
      confidence: number;
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
  const RETURN_LIMIT = Math.max(1, Math.round((retrievalCfg?.return_limit ?? 20) * retrievalMultiplier));
  const VECTOR_LIMIT = Math.max(1, Math.round((retrievalCfg?.vector_limit ?? 100) * retrievalMultiplier));
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
  try {
    [localSearch, webResults] = await Promise.all([
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

  const journalSearch = await hybridSearch(db, embedder, text, config, {
    sourceType: "journal",
    limit: JOURNAL_GROUP_LIMIT * JOURNAL_ENTRIES_PER_GROUP * 3,
    queryEmbedding,
    vectorLimit: Math.max(50, JOURNAL_GROUP_LIMIT * JOURNAL_ENTRIES_PER_GROUP * 2),
    textModel: config.ai.embedding.model,
  });

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
  const journalSelected: Array<{
    jr: HybridSearchResult;
    chunkRow: ReturnType<typeof getChunk>;
    narrativeId: string;
    topics: string[];
  }> = [];

  for (const jr of journalSearch.results) {
    if (jr.score < JOURNAL_MIN_SCORE) {
      if (tracing) traceCandidates.push({ chunkId: jr.chunkId, score: jr.score, content_preview: jr.content.slice(0, 120), narrative_id: null, narrative_name: null, topics: [], filter_reason: "below_min_score" });
      continue;
    }
    const chunkRow = getChunk(db, jr.chunkId);
    if (!chunkRow?.narrative_id) {
      if (tracing) traceCandidates.push({ chunkId: jr.chunkId, score: jr.score, content_preview: jr.content.slice(0, 120), narrative_id: null, narrative_name: null, topics: [], filter_reason: "no_narrative_id" });
      continue;
    }
    const narrativeId = chunkRow.narrative_id;
    const count = perNarrativeCount.get(narrativeId) ?? 0;
    if (count >= JOURNAL_ENTRIES_PER_GROUP) {
      if (tracing) traceCandidates.push({ chunkId: jr.chunkId, score: jr.score, content_preview: jr.content.slice(0, 120), narrative_id: narrativeId, narrative_name: null, topics: [], filter_reason: "entries_per_group_limit" });
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
      traceCandidates.push({ chunkId: jr.chunkId, score: jr.score, content_preview: jr.content.slice(0, 120), narrative_id: narrativeId, narrative_name: null, topics, filter_reason: "included" });
    }
    for (const { jr, narrativeId, topics } of journalSelected.slice(JOURNAL_TOTAL_LIMIT)) {
      traceCandidates.push({ chunkId: jr.chunkId, score: jr.score, content_preview: jr.content.slice(0, 120), narrative_id: narrativeId, narrative_name: null, topics, filter_reason: "total_limit" });
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
        for (const [conceptName] of conceptBoosts) {
          if (resultConceptNames.has(conceptName)) continue;
          const conceptRow = activeConceptsByName.get(conceptName);
          if (!conceptRow) continue;
          const activeChunkId =
            conceptRow.active_chunk_id ??
            getChunksForConcept(db, conceptRow.id).at(-1)?.id;
          if (!activeChunkId) continue;
          const chunkRow = getChunk(db, activeChunkId);
          if (!chunkRow) continue;
          try {
            const parsed = await readChunk(chunkRow.file_path);
            // Score equivalent to rank-1 in a virtual symbol lane: 1/(k+1)
            rerankedResults.push({
              chunkId: activeChunkId,
              score: 1 / (config.rrf.k + 1),
              content: parsed.content,
              concept: conceptName,
              warning: undefined,
            });
            resultConceptNames.add(conceptName);
          } catch {
            // Skip if chunk unreadable
          }
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

  // Staleness penalty: old concepts lose up to 10% relevance, fresh ones lose nothing.
  // This rewards recently closed narratives and penalizes concepts that haven't been
  // revisited — the opposite of the old logic which penalized new concepts.
  // Uses config.thresholds.staleness_days as the full-staleness horizon (same as computeStaleness).
  const stalenessDecayDays = config.thresholds?.staleness_days ?? 90;
  if (stalenessDecayDays > 0) {
    for (const r of rerankedResults) {
      const chunk = getChunk(db, r.chunkId);
      const concept = chunk?.concept_id ? getConcept(db, chunk.concept_id) : null;
      if (concept?.inserted_at) {
        const ageMs = Date.now() - new Date(concept.inserted_at).getTime();
        const ageDays = ageMs / 86_400_000;
        const staleness = Math.min(1, ageDays / stalenessDecayDays);
        // Max 10% penalty at full staleness for healthy debt bands.
        // Higher debt bands increase this penalty to favor fresher concepts.
        const penalty = Math.min(0.3, 0.1 * staleness * stalenessPenaltyMultiplier);
        r.score = Math.max(0.01, r.score * (1 - penalty));
      }
    }
  }

  // Concept-level dedup: when multiple chunks share the same concept/symbol name,
  // keep only the highest-scoring entry per concept. This prevents source chunks
  // from the same symbol (e.g. test fixtures) consuming multiple summary slots.
  // Entries without a concept name are treated as unique (never deduped).
  {
    const seenConcepts = new Map<string, number>(); // concept → index in deduped
    const deduped: HybridSearchResult[] = [];
    for (const r of rerankedResults) {
      if (!r.concept) {
        deduped.push(r);
        continue;
      }
      const existingIdx = seenConcepts.get(r.concept);
      if (existingIdx === undefined) {
        seenConcepts.set(r.concept, deduped.length);
        deduped.push(r);
      } else if (r.score > deduped[existingIdx]!.score) {
        deduped[existingIdx] = r;
      }
      // else: lower score duplicate — skip
    }
    rerankedResults = deduped;
  }

  // Graph fusion strength for always-on PPR score blending.
  // final_score = base_score + alpha * ppr_signal
  const configuredPprAlpha = retrievalOptsCfg?.ppr_fusion_alpha;
  const PPR_FUSION_ALPHA =
    typeof configuredPprAlpha === "number" && Number.isFinite(configuredPprAlpha)
      ? Math.max(0, Math.min(1, configuredPprAlpha))
      : 0.2;
  // Limit symbol->concept projection work to strongest graph nodes.
  const PPR_SYMBOL_PROJECTION_LIMIT = 40;
  const pprInfluencedChunkIds = new Set<string>();
  const pprExpansionMeta = {
    fusion_alpha: PPR_FUSION_ALPHA,
    deep_research_query: isLikelyDeepResearchQuery(text),
    seeds: 0,
    adjacency_nodes: 0,
    expansion_candidates: 0,
    injected: 0,
    in_summary_input: 0,
  };

  // ── PPR graph expansion (J10: deep research) ──────────────────────────────
  // After concept dedup, expand the result set via the call graph to surface
  // bridge nodes that connect the query's direct hits. Uses Personalized PageRank
  // seeded from bound symbols of the top results.
  try {
    const pprSeedSymbols: string[] = [];
    const existingConceptNames = new Set(
      rerankedResults.map((r) => r.concept).filter((n): n is string => n != null),
    );

    // Collect bound symbol qualified names from top 5 results
    for (const r of rerankedResults.slice(0, 5)) {
      const chunk = getChunk(db, r.chunkId);
      if (!chunk?.concept_id) continue;
      const bindings = getBindingSummariesForConcept(db, chunk.concept_id);
      for (const b of bindings.slice(0, 3)) {
        pprSeedSymbols.push(b.symbol_qualified_name);
      }
    }
    pprExpansionMeta.seeds = pprSeedSymbols.length;

    if (pprSeedSymbols.length > 0) {
      const adjacency = buildCallGraphAdjacency(db, pprSeedSymbols, 2);
      pprExpansionMeta.adjacency_nodes = adjacency.size;
      const pprScores = personalizedPageRank(adjacency, pprSeedSymbols);

      // Work only with non-seed nodes (potential bridges/connectors).
      const seedSet = new Set(pprSeedSymbols);
      const nonSeedScores = Array.from(pprScores.entries())
        .filter(([sym]) => !seedSet.has(sym))
        .sort(([, a], [, b]) => b - a);

      // Normalize PPR scores so top bridge node has signal 1.0.
      const topNonSeedScore = nonSeedScores[0]?.[1] ?? 0;
      const conceptPprSignal = new Map<string, number>();
      for (const [symName, pprScore] of nonSeedScores.slice(0, PPR_SYMBOL_PROJECTION_LIMIT)) {
        const sym = getSymbolByQualifiedName(db, symName);
        if (!sym) continue;
        const conceptMatches = getConceptsForSymbols(db, [sym.id]);
        if (conceptMatches.length === 0) continue;

        const normalizedPpr = topNonSeedScore > 0 ? pprScore / topNonSeedScore : 0;
        for (const match of conceptMatches) {
          const signal = normalizedPpr * match.confidence;
          const prev = conceptPprSignal.get(match.concept_name) ?? 0;
          if (signal > prev) conceptPprSignal.set(match.concept_name, signal);
        }
      }

      // Always-on fusion: boost existing candidates using graph signal.
      for (const result of rerankedResults) {
        if (!result.concept) continue;
        const pprSignal = conceptPprSignal.get(result.concept);
        if (!pprSignal || pprSignal <= 0) continue;
        result.score += PPR_FUSION_ALPHA * pprSignal;
        pprInfluencedChunkIds.add(result.chunkId);
      }

      // Inject top unseen graph-linked concepts.
      const expansionCandidates = Array.from(conceptPprSignal.entries())
        .filter(([conceptName]) => !existingConceptNames.has(conceptName))
        .sort(([, a], [, b]) => b - a)
        .slice(0, 5);
      pprExpansionMeta.expansion_candidates = expansionCandidates.length;

      if (expansionCandidates.length > 0) {
        const allActiveConcepts = getActiveConcepts(db);
        const activeConceptsByName = new Map(allActiveConcepts.map((c) => [c.name, c]));

        // Sync phase: resolve DB lookups for each candidate
        type ReadTarget = { filePath: string; chunkId: string; conceptName: string; injectScore: number };
        const toRead: ReadTarget[] = [];
        for (const [conceptName, pprSignal] of expansionCandidates) {
          const conceptRow = activeConceptsByName.get(conceptName);
          if (!conceptRow?.active_chunk_id) continue;
          const chunkRow = getChunk(db, conceptRow.active_chunk_id);
          if (!chunkRow) continue;

          // Reserve the slot now to prevent duplicates across concurrent reads
          existingConceptNames.add(conceptName);
          toRead.push({
            filePath: chunkRow.file_path,
            chunkId: conceptRow.active_chunk_id,
            conceptName,
            injectScore: PPR_FUSION_ALPHA * pprSignal,
          });
        }

        // Async phase: fan out file reads concurrently
        const reads = await Promise.all(
          toRead.map(async (c) => {
            try {
              const parsed = await readChunk(c.filePath);
              return { ...c, content: parsed.content };
            } catch {
              return null;
            }
          }),
        );

        let injected = 0;
        for (const r of reads) {
          if (!r) continue;
          rerankedResults.push({
            chunkId: r.chunkId,
            score: r.injectScore,
            content: r.content,
            concept: r.conceptName,
            warning: undefined,
          });
          pprInfluencedChunkIds.add(r.chunkId);
          injected++;
        }
        pprExpansionMeta.injected = injected;
      }

      // Re-sort after graph fusion/injection.
      if (conceptPprSignal.size > 0 || pprExpansionMeta.injected > 0) {
        rerankedResults.sort((a, b) => b.score - a.score);
      }
    }
    opts?.tracer?.log("ppr_expansion", pprExpansionMeta);
  } catch {
    // PPR expansion is non-fatal — if call_sites table or symbols are missing, continue
    opts?.tracer?.log("ppr_expansion", {
      ...pprExpansionMeta,
      error: "non-fatal expansion failure",
    });
  }

  // Build concept ID→name map for relation resolution
  const conceptNameMap = new Map<string, string>();

  const results = rerankedResults.map((r) => {
    let content = r.content;
    let excerpts: string[] | undefined;
    if (opts?.brief) {
      excerpts = extractBriefExcerpts(r.content, text);
      content = excerpts.join("\n\n...\n\n");
    }

    const chunk = getChunk(db, r.chunkId);
    const concept = chunk?.concept_id ? getConcept(db, chunk.concept_id) : null;

    if (concept) {
      conceptNameMap.set(concept.id, concept.name);
    }

    // Get files, bindings, relations, and symbol drift
    let files: string[] = [];
    let symbolsBound = 0;
    let symbolsDrifted = 0;
    let bindingSummaries: ConceptBindingSummary[] = [];
    let relationRows: ConceptRelationRow[] = [];
    if (concept) {
      try {
        files = getFilesForConcept(db, concept.id);
        const bindings = getBindingsForConcept(db, concept.id);
        symbolsBound = bindings.length;
        symbolsDrifted = driftedByConceptId.get(concept.id) ?? 0;
        bindingSummaries = getBindingSummariesForConcept(db, concept.id);
      } catch {
        // pre-scan safety
      }
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
    if (concept?.staleness != null && concept.staleness > 0.5) {
      warnings.push(`concept is stale (staleness: ${concept.staleness.toFixed(2)})`);
    }
    if (concept?.staleness != null && concept.staleness > 0.4) {
      const lastUpdatedDate = new Date(chunk?.created_at ?? concept.inserted_at);
      const ageDays = (Date.now() - lastUpdatedDate.getTime()) / (1000 * 60 * 60 * 24);
      if (ageDays > 7) {
        warnings.push(
          `concept may need refresh — staleness ${concept.staleness.toFixed(2)}, last updated ${Math.round(ageDays)}d ago`,
        );
      }
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
            const viaName = conceptNameMap.get(h.via) ?? (() => {
              const c = getConcept(db, h.via);
              if (c) conceptNameMap.set(c.id, c.name);
              return c?.name ?? h.via;
            })();
            const targetName = conceptNameMap.get(h.conceptId) ?? (() => {
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
    let lastNarrative: { name: string; intent: string; closed_at: string } | undefined;
    if (concept) {
      try {
        const ld = getLastNarrativeForConcept(db, concept.id);
        if (ld) lastNarrative = ld;
      } catch {
        // pre-narrative safety
      }
    }

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
        residual: concept?.residual ?? null,
        staleness: concept?.staleness ?? null,
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
  const maxGroundingHits = Math.max(1, retrievalOptsCfg?.max_grounding_hits ?? 8);

  // Score-gated summary input: filter by min_relevance when reranker was applied
  const minRelevance = rrCfg?.min_relevance ?? 0;
  const summaryInput = rerankedResults
    .filter((r) => !rerankApplied || r.score >= minRelevance)
    .slice(0, summaryMaxMatches);
  pprExpansionMeta.in_summary_input = summaryInput.reduce(
    (count, item) => count + (pprInfluencedChunkIds.has(item.chunkId) ? 1 : 0),
    0,
  );
  opts?.tracer?.log("ppr_summary_input", {
    in_summary_input: pprExpansionMeta.in_summary_input,
    summary_input_size: summaryInput.length,
    injected_total: pprExpansionMeta.injected,
  });

  opts?.onProgress?.("grounding code evidence");

  // Detect source chunks — direct code reads that serve as authoritative grounding.
  // Track symbols with no concept binding so the agent can be nudged to bind them.
  const sourceChunksInInput = summaryInput.filter((r) => r.content.startsWith("[Source:"));
  const hasSourceChunks = sourceChunksInInput.length > 0;
  const unboundSourceSymbols: string[] = [];
  if (hasSourceChunks) {
    const candidateNames = [
      ...new Set(
        sourceChunksInInput.map((r) => r.concept).filter((n): n is string => n != null),
      ),
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
  const groundingMatches = summaryInput.map((result) => {
    const chunk = getChunk(db, result.chunkId);
    const concept = chunk?.concept_id ? getConcept(db, chunk.concept_id) : null;
    let symbolLines: ConceptSymbolLineRange[] = [];
    if (concept) {
      try {
        symbolLines = getSymbolLinesForConcept(db, concept.id);
      } catch {
        // pre-scan safety
      }
    }
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
    const summarySources: ProvenanceSource[] = results.slice(0, summaryMaxMatches).map((r) => ({
      concept: r.concept,
      score: r.meta.score,
      files: r.meta.files,
      staleness: r.meta.staleness,
      last_updated: r.meta.last_updated,
    }));
    const summaryStartMs = Date.now();

    try {
      const summary = await generateExecutiveSummary(
        opts.summary_generator,
        text,
        summaryInput.map((r) => ({
          concept: r.concept ?? "unknown",
          score: r.score,
          content: r.content.slice(0, summaryMaxChars),
        })),
        rerankedResults.length,
        summaryReasoning,
        summaryTimeoutMs,
        {
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
      ppr_expansion: pprExpansionMeta,
      ...(opts?.ask_debt
        ? {
            ask_debt: {
              score: opts.ask_debt.score,
              confidence: opts.ask_debt.confidence,
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
  "mcp",
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

const SUMMARY_GROUNDING_EXACTNESS_HINTS = [
  "exact",
  "file path",
  "filepath",
  "function",
  "method",
  "where defined",
  "line",
  "symbol",
  "entrypoint",
];
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
  if (SUMMARY_GROUNDING_EXACTNESS_HINTS.some((hint) => lower.includes(hint))) return true;
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
  for (const sym of allSymbolLines) {
    if (dedup.size >= 30) break;
    const content = await readSymbolContent(codePath, sym.file_path, sym.line_start, sym.line_end);
    if (!content) continue;
    const snippet = compactSnippet(content, SUMMARY_GROUNDING_SNIPPET_MAX);
    const key = `${sym.file_path}:${sym.line_start}`;
    if (!dedup.has(key)) {
      dedup.set(key, {
        file: sym.file_path,
        line: sym.line_start,
        snippet,
        term: sym.symbol_name,
      });
    }
  }

  // Collect call-site edges for matched symbols (bidirectional), coalesce adjacent
  const callSiteHits: SummaryGroundingHit[] = [];
  if (db) {
    const seenSymbols = new Set<string>();
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
          if (callSiteHits.length >= 30) break;
          const key = `call:${group.file_path}:${group.lineStart}`;
          if (dedup.has(key)) continue;
          const content = await readSymbolContent(
            codePath,
            group.file_path,
            group.lineStart,
            group.lineEnd,
          );
          const snippet = content
            ? compactSnippet(content, SUMMARY_GROUNDING_SNIPPET_MAX)
            : group.fallback;
          const hit: SummaryGroundingHit = {
            file: group.file_path,
            line: group.lineStart,
            snippet,
            term: group.terms.join(", "),
          };
          callSiteHits.push(hit);
          dedup.set(key, hit);
        }
      } catch {
        // call_sites table may not exist yet (pre-migration)
      }
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
      const pos = entry.entry_index > 0 ? `Entry ${entry.entry_index}/${group.total_entries}` : "Entry";
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

Evidence hierarchy (highest to lowest priority):
1. Investigation trail — recent agent observations from closed narratives. These contain specific discoveries, exact formulas, code references, and rationale. When investigation findings contain explicit values (constants, formulas, weights), prefer them over paraphrased concept content.
2. Integrated knowledge — concept content synthesized from multiple investigations. Comprehensive but may generalize specifics.
3. Code anchors — symbol names with file:line locations. Use for grounding claims to source code.
4. Grounding evidence — file:line snippets from code search. Use for inline citations.

Conflict resolution:
- If investigation trail entries contain specific numeric values, formulas, or constants that differ from concept content, the investigation trail is more likely correct (it was observed directly from source code).
- If concept content provides broader context that investigation entries lack, combine both.`;

function parseClaimAttributions(
  narrative: string,
): { cleaned: string; claims: Array<{ text: string; source_concepts: string[] }> } {
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
  const journalEntryCount = journalGroups.reduce(
    (sum, g) => sum + g.matched_entries.length,
    0,
  );
  const counts = { concepts: conceptCount, files: fileCount, symbols: symbolCount, journal_entries: journalEntryCount };
  const citations = [
    ...grounding.hits.map((h) => ({
      file: h.file,
      line: h.line,
      snippet: h.snippet,
      term: h.term,
    })),
    ...(grounding.call_site_hits ?? []).map((h) => ({
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
      uncertainty_reason: "Could not find grounded code references for exact path/function claims",
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
      uncertainty_reason: grounding.exactness_detected
        ? "Could not produce a grounded exact summary from the available evidence"
        : "Could not produce a grounded summary from available evidence",
      sources,
      citations: [],
      counts,
      unbound_source_symbols: opts?.unboundSourceSymbols,
    };
  }
  // For non-exactness queries, strip any LLM-generated [file:line] citations
  // so our controlled per-term placement is the only source of inline refs
  const cleanedGenerated = !grounding.exactness_detected
    ? generated.replace(/\s*\[[^\]\s]+:\d+\]/g, "")
    : generated;
  const { cleaned: narrativeWithoutMarkers, claims } = parseClaimAttributions(cleanedGenerated);

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
  const narrative = getOpenNarrativeByName(db, narrativeName);
  if (!narrative) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }

  const closeSpan = tracer.span("close");
  const debtBefore = getLatestDebt(db);

  // Snapshot coverage before integration
  let coverageBefore: { exported_covered: number; exported_total: number; ratio: number } | null = null;
  try {
    const stats = getCoverageStats(db);
    coverageBefore = {
      exported_covered: stats.bound_exported,
      exported_total: stats.total_exported,
      ratio: stats.total_exported > 0 ? stats.bound_exported / stats.total_exported : 0,
    };
  } catch { /* symbols table may not exist */ }

  // Batch embed journal chunks (deferred from log time for speed)
  const embedSpan = tracer.span("batch-embed-journals");
  const journalChunks = getJournalChunksForNarrative(db, narrative.id);
  const unemeddedJournals = journalChunks.filter((c) => !getEmbeddingForChunk(db, c.id));
  if (unemeddedJournals.length > 0) {
    const journalTexts = await Promise.all(
      unemeddedJournals.map((c) => readChunk(c.file_path).then((p) => p.content)),
    );
    const journalEmbeddings = await embedder.embedBatch(journalTexts);
    for (let i = 0; i < unemeddedJournals.length; i++) {
      insertEmbedding(
        db,
        unemeddedJournals[i]!.id,
        journalEmbeddings[i]!,
        config.ai.embedding.model,
      );
      const chunkRow = getChunk(db, unemeddedJournals[i]!.id);
      if (chunkRow) {
        await writeEmbeddingFile(
          embeddingFilePath(chunkRow.file_path),
          config.ai.embedding.model,
          journalEmbeddings[i]!,
        );
      }
    }
  }
  embedSpan.end();

  // Phase transition detection: measure semantic distance between incoming narrative
  // content and existing concept embeddings. High distance signals potential contradiction.
  const PHASE_TRANSITION_THRESHOLD = 0.45;
  const phaseTransitions: PhaseTransitionWarning[] = [];

  try {
    // Get all journal embeddings for this narrative
    const allNarrativeChunks = getJournalChunksForNarrative(db, narrative.id);
    const narrativeEmbeddings: Float32Array[] = [];
    for (const chunk of allNarrativeChunks) {
      const embRow = getEmbeddingForChunk(db, chunk.id);
      if (!embRow) continue;
      const bytes = embRow.embedding instanceof Uint8Array ? embRow.embedding : new Uint8Array(embRow.embedding);
      narrativeEmbeddings.push(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4));
    }

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

      const conceptsToCheck = targetConceptNames.size > 0
        ? getActiveConcepts(db).filter((c) => targetConceptNames.has(c.name))
        : getActiveConcepts(db).slice(0, 20); // limit to top-20 when no explicit targets

      for (const concept of conceptsToCheck) {
        if (!concept.active_chunk_id) continue;
        const conceptEmbRow = getEmbeddingForChunk(db, concept.active_chunk_id);
        if (!conceptEmbRow) continue;
        const bytes = conceptEmbRow.embedding instanceof Uint8Array
          ? conceptEmbRow.embedding
          : new Uint8Array(conceptEmbRow.embedding);
        const conceptEmbedding = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
        const dist = cosineDistance(narrativeCentroid, conceptEmbedding);
        if (dist >= PHASE_TRANSITION_THRESHOLD) {
          const magnitude: PhaseTransitionWarning["magnitude"] =
            dist > 0.75 ? "structural" : dist > 0.60 ? "strong" : "moderate";
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

  // Pre-routing: handle chunks with explicit concept_refs (bypass LLM routing for targeted entries)
  const preRouteSpan = tracer.span("pre-route-journal");
  const prePlan: IntegrationPlan = { updates: [], creates: [] };
  const preTargetedConceptIds = new Set<string>();

  const allJournalChunks = getJournalChunksForNarrative(db, narrative.id);
  // Map conceptId → { entries, indices } for pre-targeted chunks
  const preTargetGroups = new Map<string, { entries: string[]; indices: number[] }>();
  for (let i = 0; i < allJournalChunks.length; i++) {
    const chunk = allJournalChunks[i]!;
    if (!chunk.concept_refs) continue;
    const conceptIds: string[] = JSON.parse(chunk.concept_refs);
    if (conceptIds.length === 0) continue;
    const content = (await readChunk(chunk.file_path)).content;
    for (const conceptId of conceptIds) {
      if (!preTargetGroups.has(conceptId)) preTargetGroups.set(conceptId, { entries: [], indices: [] });
      const g = preTargetGroups.get(conceptId)!;
      g.entries.push(content);
      g.indices.push(i);
    }
  }

  // Generate integrations for pre-targeted groups
  for (const [conceptId, group] of preTargetGroups.entries()) {
    const concept = getConcept(db, conceptId);
    if (!concept) continue;
    preTargetedConceptIds.add(conceptId);

    let existingContent = "";
    let existingChunkId: string | null = null;
    if (concept.active_chunk_id) {
      const chunkRow = getChunk(db, concept.active_chunk_id);
      if (chunkRow) {
        existingContent = (await readChunk(chunkRow.file_path)).content;
        existingChunkId = concept.active_chunk_id;
      }
    }

    const newContent = await generator.generateIntegration(
      group.entries,
      existingContent ? [existingContent] : [],
      concept.name,
      opts?.mergeStrategy,
    );

    if (!existingContent || newContent.trim() !== existingContent.trim()) {
      prePlan.updates.push({
        conceptId: concept.id,
        conceptName: concept.name,
        existingChunkId,
        newContent,
        sourceEntryIndices: group.indices,
      });
    }
  }
  preRouteSpan.end();

  // Analyze journal and produce integration plan (LLM routing for unrouted entries)
  const analyzeSpan = tracer.span("analyze-journal");
  const llmPlan = await analyzeJournal(
    db,
    narrative.id,
    generator,
    embedder,
    config,
    declaredTargets,
    opts?.mergeStrategy,
  );
  analyzeSpan.end();

  // Merge plans: pre-targeted entries win over LLM for same concepts
  const plan: IntegrationPlan = {
    updates: [...prePlan.updates],
    creates: [...prePlan.creates],
  };
  for (const update of llmPlan.updates) {
    if (!preTargetedConceptIds.has(update.conceptId)) {
      plan.updates.push(update);
    }
  }
  for (const create of llmPlan.creates) {
    plan.creates.push(create);
  }

  // Snapshot per-concept residuals before integration for impact tracking
  const residualsBefore = new Map<string, number | null>();
  for (const c of getActiveConcepts(db)) {
    residualsBefore.set(c.id, c.residual);
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

  const preparedConceptCreates: Array<{ id: string; name: string }> = [];
  const preparedChunkWrites: PreparedChunkWrite[] = [];
  let commit: ReturnType<typeof insertCommit> | null = null;

  // Collect chunk contents + IDs for batch embedding after both loops
  const pendingEmbeds: Array<{ chunkId: string; content: string }> = [];
  // Track old→new chunk pairs for residual computation (Phase 3)
  const residualPairs: Array<{ conceptId: string; newChunkId: string; oldChunkId: string | null }> =
    [];

  // Track content diffs per concept for close output
  const contentDiffs = new Map<string, { adds: number; removes: number }>();

  // Track entry index → conceptId for auto-binding symbol_refs
  const entryIndexToConceptId = new Map<number, string>();

  // Get merge base and head trees for 3-way merge
  const mergeBaseId = narrative.merge_base_commit_id;
  const head = getHeadCommit(db);
  const baseTree = mergeBaseId ? getCommitTreeAsMap(db, mergeBaseId) : new Map<string, string>();
  const headTree = head ? getCommitTreeAsMap(db, head.id) : new Map<string, string>();

  // Apply updates — 3-way merge when needed
  for (const update of plan.updates) {
    const concept = getConcept(db, update.conceptId);
    if (!concept) continue;

    const baseChunkId = baseTree.get(update.conceptId);
    const headChunkId = headTree.get(update.conceptId);

    let finalContent = update.newContent;

    // Detect conflict: concept changed on main while narrative was open
    if (baseChunkId && headChunkId && baseChunkId !== headChunkId) {
      // 3-way merge needed
      const baseChunkRow = getChunk(db, baseChunkId);
      const headChunkRow = getChunk(db, headChunkId);
      const baseContent = baseChunkRow ? (await readChunk(baseChunkRow.file_path)).content : null;
      const headContent = headChunkRow ? (await readChunk(headChunkRow.file_path)).content : "";

      const resolved = await generator.threeWayMerge(
        update.conceptName,
        baseContent,
        headContent,
        update.newContent,
      );
      finalContent = resolved;

      conflicts.push({
        conceptId: update.conceptId,
        conceptName: update.conceptName,
        baseContent,
        headContent,
        narrativeContent: update.newContent,
        resolution: "auto-merged",
        resolvedContent: resolved,
      });
    }

    // Derive next version from existing chunk frontmatter (fallback 0)
    // Also capture old content for diff computation
    let nextVersion = 1;
    let oldContent: string | null = null;
    if (concept.active_chunk_id) {
      const currentChunk = getChunk(db, concept.active_chunk_id);
      if (currentChunk) {
        const parsed = await readChunk(currentChunk.file_path);
        oldContent = parsed.content;
        const currentVersion =
          "fl_version" in parsed.frontmatter
            ? ((parsed.frontmatter as { fl_version: number }).fl_version ?? 0)
            : 0;
        nextVersion = currentVersion + 1;
      }
    }

    // Compute content diff for close output
    if (oldContent != null && !isDiffTooLarge(oldContent, finalContent)) {
      const hunks = computeLineDiff(oldContent, finalContent);
      let adds = 0, removes = 0;
      for (const h of hunks) {
        for (const l of h.lines) {
          if (l.type === "add") adds++;
          else if (l.type === "remove") removes++;
        }
      }
      contentDiffs.set(update.conceptName, { adds, removes });
    }

    const { id, filePath } = await writeStateChunk({
      lorePath,
      concept: update.conceptName,
      conceptId: update.conceptId,
      narrativeOrigin: narrativeName,
      version: nextVersion,
      supersedes: update.existingChunkId,
      content: finalContent,
    });

    preparedChunkWrites.push({
      conceptId: update.conceptId,
      conceptName: update.conceptName,
      existingChunkId: update.existingChunkId,
      chunkId: id,
      filePath,
      content: finalContent,
      sourceEntryIndices: update.sourceEntryIndices,
    });

    // Defer embedding to batch — collect content
    pendingEmbeds.push({ chunkId: id, content: finalContent });

    // Track for residual computation
    residualPairs.push({
      conceptId: update.conceptId,
      newChunkId: id,
      oldChunkId: update.existingChunkId,
    });

    // Track entry index → conceptId for auto-binding
    for (const idx of update.sourceEntryIndices) {
      entryIndexToConceptId.set(idx, update.conceptId);
    }

    conceptsUpdated.push(update.conceptName);
  }

  // Create new concepts — check for concurrent creates
  for (const create of plan.creates) {
    const existingConcept = getConceptByName(db, create.conceptName);

    let finalContent = create.content;
    let conceptId: string;

    if (existingConcept && !baseTree.has(existingConcept.id)) {
      // Concurrent create — concept exists now but didn't at merge base
      conceptId = existingConcept.id;
      if (existingConcept.active_chunk_id) {
        const headChunkRow = getChunk(db, existingConcept.active_chunk_id);
        const headContent = headChunkRow ? (await readChunk(headChunkRow.file_path)).content : "";

        const resolved = await generator.threeWayMerge(
          create.conceptName,
          null,
          headContent,
          create.content,
        );
        finalContent = resolved;

        conflicts.push({
          conceptId,
          conceptName: create.conceptName,
          baseContent: null,
          headContent,
          narrativeContent: create.content,
          resolution: "auto-merged",
          resolvedContent: resolved,
        });
      }
    } else if (existingConcept) {
      // Concept already existed — treat as update
      conceptId = existingConcept.id;
    } else {
      conceptId = ulid();
      preparedConceptCreates.push({ id: conceptId, name: create.conceptName });
    }

    // Version: existing concept -> prior + 1, else 1
    let nextVersion = 1;
    if (existingConcept?.active_chunk_id) {
      const currentChunk = getChunk(db, existingConcept.active_chunk_id);
      if (currentChunk) {
        const parsed = await readChunk(currentChunk.file_path);
        const currentVersion =
          "fl_version" in parsed.frontmatter
            ? ((parsed.frontmatter as { fl_version: number }).fl_version ?? 0)
            : 0;
        nextVersion = currentVersion + 1;
      }
    }

    const { id, filePath } = await writeStateChunk({
      lorePath,
      concept: create.conceptName,
      conceptId,
      narrativeOrigin: narrativeName,
      version: nextVersion,
      content: finalContent,
    });

    preparedChunkWrites.push({
      conceptId,
      conceptName: create.conceptName,
      existingChunkId: null,
      chunkId: id,
      filePath,
      content: finalContent,
      sourceEntryIndices: create.sourceEntryIndices,
    });

    // Defer embedding to batch — collect content
    pendingEmbeds.push({ chunkId: id, content: finalContent });

    // New concepts start with residual 0
    residualPairs.push({ conceptId, newChunkId: id, oldChunkId: null });

    // Track content diff for new concepts (all lines are adds)
    const newLines = finalContent.split("\n").length;
    contentDiffs.set(create.conceptName, { adds: newLines, removes: 0 });

    // Track entry index → conceptId for auto-binding
    for (const idx of create.sourceEntryIndices) {
      entryIndexToConceptId.set(idx, conceptId);
    }

    conceptsCreated.push(create.conceptName);
  }

  // Batch embed all new state chunks
  const stateEmbedSpan = tracer.span("batch-embed-state");
  const embeddingByChunkId = new Map<string, Float32Array>();
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
    for (const concept of preparedConceptCreates) {
      insertConceptRaw(db, concept.id, concept.name, { activeChunkId: null });
    }
    for (const chunk of preparedChunkWrites) {
      insertChunk(db, {
        id: chunk.chunkId,
        filePath: chunk.filePath,
        flType: "chunk",
        conceptId: chunk.conceptId,
        narrativeId: narrative.id,
        supersedesId: chunk.existingChunkId,
        createdAt: new Date().toISOString(),
      });
      insertFtsContent(db, chunk.content, chunk.chunkId);
      const embedding = embeddingByChunkId.get(chunk.chunkId);
      if (embedding) {
        insertEmbedding(db, chunk.chunkId, embedding, config.ai.embedding.model);
      }
      insertConceptVersion(db, chunk.conceptId, { active_chunk_id: chunk.chunkId, staleness: 0 });
    }
    const treeEntries: Array<{ conceptId: string; chunkId: string; conceptName: string }> = [];
    for (const concept of getConcepts(db)) {
      if (concept.active_chunk_id && (concept.lifecycle_status == null || concept.lifecycle_status === "active")) {
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
    db.run("COMMIT");
  } catch (error) {
    try {
      db.run("ROLLBACK");
    } catch {}
    throw error;
  }

  for (const chunk of preparedChunkWrites) {
    try {
      if (chunk.existingChunkId) {
        const oldChunk = getChunk(db, chunk.existingChunkId);
        if (oldChunk) {
          await markSupersededOnDisk(oldChunk.file_path, chunk.chunkId);
        }
      }
      if (embeddedAt && embeddingByChunkId.has(chunk.chunkId)) {
        await updateChunkFrontmatter(chunk.filePath, {
          fl_embedding_model: config.ai.embedding.model,
          fl_embedded_at: embeddedAt,
        });
        await writeEmbeddingFile(
          embeddingFilePath(chunk.filePath),
          config.ai.embedding.model,
          embeddingByChunkId.get(chunk.chunkId)!,
        );
      }
    } catch {
      // Best-effort metadata updates must not invalidate an already committed close.
    }
  }

  if (pendingEmbeds.length > 0) {
    const contentByChunkId = new Map<string, string>();
    for (const pe of pendingEmbeds) {
      contentByChunkId.set(pe.chunkId, pe.content);
    }
    const codeEmbedder = opts?.codeEmbedder ?? null;

    // Store per-symbol code embeddings for code-lane retrieval
    if (codeEmbedder && config.ai.embedding.code?.model && codePath) {
      const codeModel = config.ai.embedding.code.model;
      try {
        const allSymbols: { symbolId: string; content: string }[] = [];
        for (const pair of residualPairs) {
          const symbolLines = getSymbolLinesForConcept(db, pair.conceptId);
          for (const sym of symbolLines) {
            const content = await readSymbolContent(codePath, sym.file_path, sym.line_start, sym.line_end);
            if (content) allSymbols.push({ symbolId: sym.symbol_id, content });
          }
        }
        if (allSymbols.length > 0) {
          const embs = await codeEmbedder.embedBatch(allSymbols.map((s) => s.content));
          for (let i = 0; i < allSymbols.length; i++) {
            insertSymbolEmbedding(db, allSymbols[i]!.symbolId, embs[i]!, codeModel);
          }
        }
      } catch {
        // Non-fatal: code embedding storage failure should not block close
      }
    }

    for (const pair of residualPairs) {
      const newEmb = embeddingByChunkId.get(pair.newChunkId);

      // churn = version-to-version cosine distance (informational)
      let churn = 0;
      if (pair.oldChunkId && newEmb) {
        const oldEmb = getEmbeddingForChunk(db, pair.oldChunkId);
        if (oldEmb) {
          const oldVec = new Float32Array(oldEmb.embedding.buffer);
          churn = cosineDistance(oldVec, newEmb);
        }
      }

      // ground_residual = concept vs symbol content in code embedding space (or text fallback)
      let groundResidual: number | null = null;
      if (codePath) {
        const symbolLines = getSymbolLinesForConcept(db, pair.conceptId);
        const symbolContents: string[] = [];
        const symbolConfidences: number[] = [];
        for (const sym of symbolLines) {
          const content = await readSymbolContent(
            codePath,
            sym.file_path,
            sym.line_start,
            sym.line_end,
          );
          if (content) {
            symbolContents.push(content);
            symbolConfidences.push(sym.confidence);
          }
        }
        if (symbolContents.length > 0) {
          try {
            if (codeEmbedder) {
              // Code model: re-embed concept text + symbols in shared code space.
              // Weight each symbol embedding by its binding confidence so high-confidence
              // bindings dominate the ground_residual signal.
              const conceptText = contentByChunkId.get(pair.newChunkId);
              if (conceptText) {
                const allTexts = [conceptText, ...symbolContents];
                const allEmbs = await codeEmbedder.embedBatch(allTexts);
                groundResidual = cosineDistance(allEmbs[0]!, weightedAverageVectors(allEmbs.slice(1), symbolConfidences));
              }
            } else if (newEmb) {
              // Fallback: text model — also confidence-weighted
              const symbolEmbeddings = await embedder.embedBatch(symbolContents);
              groundResidual = cosineDistance(newEmb, weightedAverageVectors(symbolEmbeddings, symbolConfidences));
            }
          } catch {
            // If embedding fails, fall back to churn
            groundResidual = churn;
          }
        } else {
          // No symbol content available → fall back to churn as ground signal
          groundResidual = churn;
        }
      } else {
        groundResidual = churn;
      }

      // residual (deprecated) = max(ground_residual, lore_residual) — lore_residual computed later
      const residual = groundResidual ?? churn;

      insertConceptVersion(db, pair.conceptId, {
        churn,
        ground_residual: groundResidual,
        residual,
      });
      const chunkRow = getChunk(db, pair.newChunkId);
      if (chunkRow) {
        await updateChunkFrontmatter(chunkRow.file_path, {
          fl_residual: residual,
          fl_staleness: 0,
        });
      }
    }
  }
  stateEmbedSpan.end();

  // Re-cluster concepts
  const discoverSpan = tracer.span("discover-concepts");
  if (conceptsUpdated.length > 0 || conceptsCreated.length > 0) {
    await discoverConcepts(db, generator);
  }
  discoverSpan.end();

  // ─── Symbol binding extraction ──────────────────────────────────
  const bindingSpan = tracer.span("symbol-bindings");
  if (codePath) {
    // Collect unique file paths from refs of touched concepts
    const touchedConceptIdSet = new Set<string>();
    for (const name of conceptsUpdated) {
      const c = getConcepts(db).find((x) => x.name === name);
      if (c) touchedConceptIdSet.add(c.id);
    }
    for (const name of conceptsCreated) {
      const c = getConcepts(db).find((x) => x.name === name);
      if (c) touchedConceptIdSet.add(c.id);
    }

    if (touchedConceptIdSet.size > 0) {
      // Collect unique file paths from symbol bindings for targeted rescan
      const filePaths = new Set<string>();
      for (const cid of touchedConceptIdSet) {
        for (const fp of getFilesForConcept(db, cid)) {
          filePaths.add(fp);
        }
      }

      // Targeted rescan to ensure symbol index is fresh
      if (filePaths.size > 0) {
        await rescanFiles(db, codePath, [...filePaths]);
      }

      // Extract bindings for touched concepts (forward: regex mention matching)
      await extractBindingsForConcepts(db, [...touchedConceptIdSet]);

      // Auto-bind by file overlap (upgrades mention bindings and adds file-path-based ones)
      await autoBindByFileOverlap(db, { conceptIds: [...touchedConceptIdSet] });

      // Prune orphaned bindings
      pruneOrphanedBindings(db);
    }
  }
  bindingSpan.end();

  // ─── Auto-bind symbol_refs from journal entries ──────────────────
  let autoBoundSymbolCount = 0;
  for (let i = 0; i < allJournalChunks.length; i++) {
    const chunk = allJournalChunks[i]!;
    if (!chunk.symbol_refs) continue;
    const symbolIds: string[] = JSON.parse(chunk.symbol_refs);
    if (symbolIds.length === 0) continue;
    const targetConceptId = entryIndexToConceptId.get(i);
    if (!targetConceptId) continue;
    for (const symbolId of symbolIds) {
      try {
        const symRow = db
          .query<{ body_hash: string | null }, [string]>("SELECT body_hash FROM symbols WHERE id = ?")
          .get(symbolId);
        upsertConceptSymbol(db, {
          conceptId: targetConceptId,
          symbolId,
          bindingType: "mention",
          boundBodyHash: symRow?.body_hash ?? null,
          confidence: 0.6,
        });
        autoBoundSymbolCount++;
      } catch {
        // Non-fatal: symbol may have been deleted between write and close
      }
    }
  }

  // ─── Symbol drift → staleness/residual adjustments ─────────────
  const driftSpan = tracer.span("symbol-drift");
  const concepts = getConcepts(db);

  // priority set (existing logic) to limit scope
  const priority = concepts
    .filter((c) => conceptPressureBase(c) > 0.3 || (c.staleness ?? 0) > 0.5)
    .map((c) => c.id);

  const touchedConceptIds = new Set<string>(
    [...conceptsUpdated, ...conceptsCreated]
      .map((name) => {
        const c = concepts.find((x) => x.name === name);
        return c?.id;
      })
      .filter(Boolean) as string[],
  );

  const scopedConcepts = new Set<string>(priority);
  for (const id of touchedConceptIds) scopedConcepts.add(id);

  // Get drifted bindings for staleness adjustment
  let closeDriftedBindings: SymbolDriftResult[] = [];
  try {
    closeDriftedBindings = getDriftedBindings(db);
  } catch {
    // pre-scan safety
  }
  const closeDriftByConceptId = new Map<string, number>();
  for (const drift of closeDriftedBindings) {
    closeDriftByConceptId.set(
      drift.concept_id,
      (closeDriftByConceptId.get(drift.concept_id) ?? 0) + 1,
    );
  }

  for (const concept of concepts) {
    if (!scopedConcepts.has(concept.id)) continue;
    const chunkId = concept.active_chunk_id;
    if (!chunkId) continue;
    const chunkRow = getChunk(db, chunkId);
    if (!chunkRow) continue;

    const baseStaleness = computeStaleness(chunkRow.created_at, config);
    let newStaleness = baseStaleness;
    let newGroundResidual = concept.ground_residual ?? concept.churn ?? 0;

    const driftCount = closeDriftByConceptId.get(concept.id) ?? 0;
    if (driftCount > 0) {
      // Symbol drift score: 1 drift = 0.5, 2 = 0.7, 3+ = 0.85, 5+ = 1.0
      let driftScore: number;
      if (driftCount >= 5) driftScore = 1.0;
      else if (driftCount >= 3) driftScore = 0.85;
      else if (driftCount >= 2) driftScore = 0.7;
      else driftScore = 0.5;
      newStaleness = Math.max(baseStaleness, driftScore);
      newGroundResidual = Math.min(1, Math.max(newGroundResidual, driftScore * 0.8));
    }

    const currentStaleness = concept.staleness ?? 0;
    const currentGroundResidual = concept.ground_residual ?? concept.churn ?? 0;
    const stalenessChanged = Math.abs(newStaleness - currentStaleness) > 1e-6;
    const groundResidualChanged = Math.abs(newGroundResidual - currentGroundResidual) > 1e-6;

    if (stalenessChanged || groundResidualChanged) {
      // residual (deprecated) = max(ground_residual, lore_residual)
      const newResidual = Math.max(newGroundResidual, concept.lore_residual ?? 0);
      insertConceptVersion(db, concept.id, {
        staleness: newStaleness,
        ground_residual: newGroundResidual,
        residual: newResidual,
      });

      await updateChunkFrontmatter(chunkRow.file_path, {
        fl_staleness: newStaleness,
        fl_residual: newResidual,
      });
    }
  }
  driftSpan.end();

  // Compute residuals and debt using fresh Fiedler from discoverConcepts
  const conceptsPost = getConcepts(db);
  const activeConceptsPost = getActiveConcepts(db);
  const postDiscoveryManifest = getManifest(db);
  const fiedlerAfter = postDiscoveryManifest?.fiedler_value ?? 0;
  recordResiduals(db, activeConceptsPost, fiedlerAfter);

  // Compute per-concept residual impacts for touched concepts
  const touchedNames = new Set([...conceptsUpdated, ...conceptsCreated]);
  const conceptImpacts: Array<{
    concept: string;
    residual_before: number | null;
    residual_after: number | null;
    content_diff?: { adds: number; removes: number };
  }> = [];
  // Re-read active concepts to get post-recordResiduals values
  const activeConceptsFresh = getActiveConcepts(db);
  for (const c of activeConceptsFresh) {
    if (touchedNames.has(c.name)) {
      conceptImpacts.push({
        concept: c.name,
        residual_before: residualsBefore.get(c.id) ?? null,
        residual_after: c.residual,
        content_diff: contentDiffs.get(c.name),
      });
    }
  }

  // ─── Concept overlap detection ─────────────────────────────────
  // Compare each touched concept's embedding against all other active concepts
  const conceptOverlaps: Array<{ concept: string; overlaps_with: string; similarity: number }> = [];
  if (touchedNames.size > 0) {
    const allActiveForOverlap = getActiveConcepts(db);
    const chunkIds = allActiveForOverlap
      .filter((c) => c.active_chunk_id != null)
      .map((c) => c.active_chunk_id!);

    // Batch fetch all needed embeddings in one query instead of N round-trips
    const embeddingMap = new Map<string, Float32Array>();
    if (chunkIds.length > 0) {
      const ph = chunkIds.map(() => "?").join(", ");
      const embRows = db
        .query<{ chunk_id: string; embedding: Uint8Array }, string[]>(
          `SELECT chunk_id, embedding FROM embeddings WHERE chunk_id IN (${ph})`,
        )
        .all(...chunkIds);
      for (const row of embRows) {
        embeddingMap.set(row.chunk_id, new Float32Array(row.embedding.buffer));
      }
    }

    // For each touched concept, compare against all non-touched active concepts
    for (const c of allActiveForOverlap) {
      if (!touchedNames.has(c.name) || !c.active_chunk_id) continue;
      const touchedEmb = embeddingMap.get(c.active_chunk_id);
      if (!touchedEmb) continue;
      for (const other of allActiveForOverlap) {
        if (other.id === c.id || touchedNames.has(other.name) || !other.active_chunk_id) continue;
        const otherEmb = embeddingMap.get(other.active_chunk_id);
        if (!otherEmb) continue;
        const similarity = 1 - cosineDistance(touchedEmb, otherEmb);
        if (similarity > 0.75) {
          conceptOverlaps.push({ concept: c.name, overlaps_with: other.name, similarity });
        }
      }
    }
    conceptOverlaps.sort((a, b) => b.similarity - a.similarity);
  }

  // Persist cluster assignments to frontmatter for scoped concepts
  for (const concept of conceptsPost) {
    if (!scopedConcepts.has(concept.id)) continue;
    const chunkId = concept.active_chunk_id;
    if (!chunkId) continue;
    const chunkRow = getChunk(db, chunkId);
    if (chunkRow) {
      await updateChunkFrontmatter(chunkRow.file_path, { fl_cluster: concept.cluster ?? null });
    }
  }

  if (!commit) {
    throw new LoreError("COMMIT_NOT_FOUND", `Close commit for narrative '${narrativeName}' was not created`);
  }

  // Update manifest
  const debtAfter = computeTotalDebt(activeConceptsPost, fiedlerAfter);
  const debtTrend = computeDebtTrend(debtAfter, debtBefore);
  upsertManifest(db, {
    chunk_count: getChunkCount(db),
    concept_count: getActiveConceptCount(db),
    debt: debtAfter,
    debt_trend: debtTrend,
    last_integrated: new Date().toISOString(),
  });

  // Execute lifecycle targets (rename, archive, restore, merge, split)
  const lifecycleTargets = declaredTargets.filter((t) => t.op !== "create" && t.op !== "update");
  if (lifecycleTargets.length > 0 && opts?.lifecycleTargetHandler) {
    for (const target of lifecycleTargets) {
      await opts.lifecycleTargetHandler(target);
    }
  }

  // Determine follow-up
  let followUp: string | undefined;
  const highResidual = concepts.find((c) => conceptPressureBase(c) > 0.5);
  if (highResidual) {
    followUp = `${highResidual.name} concept has high pressure — consider a follow-up narrative`;
  }
  if (conflicts.length > 0) {
    const conflictNote = `${conflicts.length} merge conflict(s) auto-resolved`;
    followUp = followUp ? `${followUp}. ${conflictNote}` : conflictNote;
  }
  if (conceptsCreated.length > 0 || conceptsUpdated.length > 0) {
    // Only suggest manual scan+bind if we didn't auto-bind symbols from entry refs
    if (autoBoundSymbolCount === 0) {
      const bindNote = "Run scan() then bind symbols to updated concepts for drift detection.";
      followUp = followUp ? `${followUp}. ${bindNote}` : bindNote;
    }
  }

  // Snapshot coverage after integration
  let coverageChange: CloseResult["coverage_change"];
  if (coverageBefore) {
    try {
      const statsAfter = getCoverageStats(db);
      const coverageAfter = {
        exported_covered: statsAfter.bound_exported,
        exported_total: statsAfter.total_exported,
        ratio: statsAfter.total_exported > 0 ? statsAfter.bound_exported / statsAfter.total_exported : 0,
      };
      coverageChange = { before: coverageBefore, after: coverageAfter };
    } catch { /* symbols table may not exist */ }
  }

  closeSpan.end();
  const traceSummary = tracer.summary();
  if (traceSummary) console.error(traceSummary);
  tracer.reset();

  return {
    mode: "merge",
    integrated: true,
    commit_id: commit.id,
    concepts_updated: conceptsUpdated,
    concepts_created: conceptsCreated,
    conflicts,
    impact: {
      summary: `Debt ${debtAfter < debtBefore ? "reduced" : "increased"} ${Math.abs(((debtBefore - debtAfter) / (debtBefore || 1)) * 100).toFixed(0)}%.`,
      debt_before: debtBefore,
      debt_after: debtAfter,
      concept_impacts: conceptImpacts.length > 0 ? conceptImpacts : undefined,
    },
    follow_up: followUp,
    coverage_change: coverageChange,
    concept_overlaps: conceptOverlaps.length > 0 ? conceptOverlaps : undefined,
    phase_transitions: phaseTransitions.length > 0 ? phaseTransitions : undefined,
  };
}

export function discardNarrative(db: Database, narrativeName: string): CloseResult {
  const narrative = getOpenNarrativeByName(db, narrativeName);
  if (!narrative) {
    throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
  }
  abandonDbNarrative(db, narrative.id);
  return {
    mode: "discard",
    integrated: false,
    commit_id: null,
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
