import type { Database } from "bun:sqlite";
import { resolve, basename } from "path";
import { join } from "path";
import { mkdirSync, existsSync, statSync } from "fs";
import {
  type LoreConfig,
  type RegistryEntry,
  type ProviderCredential,
  type SharedProvider,
  type RegisterResult,
  type OpenResult,
  type LogResult,
  type RunLogOptions,
  type RunListOptions,
  type RunSummary,
  type RunRow,
  type NoteOptions,
  type NoteResult,
  type JournalDesignationResult,
  type QueryResult,
  type QueryNextAction,
  type RecallResult,
  type RecallSection,
  type ExecutiveSummary,
  type CloseJob,
  type CloseJobDetail,
  type CloseWorkerRunResult,
  type CloseResult,
  type StatusResult,
  type ConceptRow,
  type ResolveDangling,
  type QueryOptions,
  type OrchestrationQueryOptions,
  type ReasoningLevel,
  type WebSearchResult,
  type TreeDiff,
  type CommitLogEntry,
  type RelationType,
  type ConceptHealthComputeResult,
  type ConceptHealthExplainResult,
  type HealConceptsResult,
  type ConceptRelationSummary,
  type ConceptTagSummary,
  type KpiDirection,
  type KpiReadingSummary,
  type KpiStatus,
  type KpiLogResult,
  type KpiGoalResult,
  type NarrativeTarget,
  type DebtTrend,
  type LoreHealthSnapshot,
  type MergeStrategy,
  LoreError,
} from "@/types/index.ts";
import {
  resolveConfig,
  loreMindPath as makeLoreMindPath,
  getDeepValue,
  setDeepValue,
  deleteDeepValue,
  loadLocalConfig,
  setGlobalConfigValue,
  writeLocalConfig,
  seedGlobalConfigIfAbsent,
  type DeepPartial,
} from "@/config/index.ts";
import { formatBytes } from "@/format.ts";
import { openDb, reclaimFreeSpace, runMigrations, vacuumDb } from "@/db/index.ts";
import { migrate as runMigrate, getMigrationStatus, type MigrationStatus } from "@/db/migrator.ts";
import {
  getManifest,
  upsertManifest,
  markGraphStale,
  getActiveNarratives,
  getDanglingNarratives,
  getNarrativeByName,
  getActiveConcepts,
  getPreviousConceptMetrics,
  getConcepts,
  getActiveConceptByName,
  getChunksForConcept,
  getChunk,
  getNarrative,
  getEmbeddingForChunk,
  getJournalChunksForNarrative,
  updateJournalChunkRouting,
  getAllNarratives,
  rebuildFromDisk,
  repairSchema,
  countOrphanedChunkRows,
  deleteOrphanedChunkRows,
  sumOrphanedChunkRows,
  countOrphanedSymbolRows,
  deleteOrphanedSymbolRows,
  sumOrphanedSymbolRows,
  walkHistory,
  resolveRef,
  diffCommitTrees,
  getCommitTreeAsMap,
  upsertConceptRelation,
  deactivateConceptRelation,
  getConceptRelations,
  upsertConceptTag,
  removeConceptTag,
  getConceptTags,
  getOpenNarratives,
  getHeadCommit,
  getKpi,
  listKpis,
  insertKpi,
  insertKpiGoal,
  getCurrentKpiGoal,
  insertKpiReading,
  listKpiReadings,
  type KpiRow,
  type KpiReadingRow,
  insertConceptHealthSignal,
  getCurrentConceptHealthSignal,
  getCurrentConceptHealthSignals,
  getConceptHealthExplainRow,
  queueConceptHealLeases,
  claimConceptHealLease,
  completeConceptHealLease,
  skipConceptHealLease,
  failConceptHealLease,
  getConceptHealLeaseStatusCounts,
  queueCloseJob,
  getCloseJob,
  getLatestPendingCloseJobForNarrative,
  listCloseJobs,
  claimCloseJob,
  completeCloseJob,
  failCloseJob,
  getCloseJobCounts,
  hasPendingCloseJobs,
  claimCloseMaintenanceJob,
  getCloseMaintenanceJob,
  completeCloseMaintenanceJob,
  failCloseMaintenanceJob,
  getCloseMaintenanceJobCounts,
  hasPendingCloseMaintenanceJobs,
  markNarrativeClosing,
  failNarrativeClose,
  reopenNarrative,
  parseLifecycleMessage,
  getLastNarrativeForConcept,
  insertQueryCache,
  insertInteractionEvent,
  getQueryCache,
  scoreQueryCache,
} from "@/db/index.ts";
import { getEdges } from "@/db/edges.ts";
import {
  loadRegistry,
  findLoreMindByCodePath,
  findLoreMindByExactPath,
  addLoreMind,
  listLoreMinds,
  removeLoreMind as removeLoreMindFromRegistry,
  listProviderConfigs,
  getProviderConfig,
  updateProviderConfig,
} from "@/storage/registry.ts";
import { ensureDir, updateChunkFrontmatter } from "@/storage/index.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { rmSync } from "fs";
import { GENERATION_PROMPT_KEYS, type GenerationPromptKey } from "@/config/prompts.ts";
import { computeLineDiff, isDiffTooLarge, type DiffHunk } from "./line-diff.ts";
import { Embedder } from "./embedder.ts";
import { Generator, buildGenerationSystemPrompt } from "./generator.ts";
import { AskTracer } from "./tracer.ts";
import {
  RECLAIM_MIN_SUPERSEDED_BYTES,
  RECLAIM_MIN_SUPERSEDED_RATIO,
  compactLanceIndex,
  getLanceSpace,
  lanceDir,
  markLanceDirty,
  rebuildLanceIndex,
  reclaimLanceSpace,
} from "./lance-index.ts";
import {
  openNarrative,
  logEntry,
  queryConcepts,
  generateExecutiveSummary,
  closeNarrativeOp,
  runCloseMaintenanceJob,
  discardNarrative,
} from "./narrative-lifecycle.ts";
import type { CloseMaintenancePayload } from "./narrative-lifecycle.ts";
import {
  INBOX_INTENT,
  INBOX_NARRATIVE,
  chooseNarrative,
  routeConcept,
  type ConceptRouting,
} from "./note-routing.ts";
import { getOpenNarrativeByName, getWritableNarrativeByName } from "@/db/narratives.ts";
import { getRun, insertRun, listRuns } from "@/db/runs.ts";
import { buildExplicitClosePlan } from "./close-planner.ts";
import { resolveJournalConceptDesignations } from "./journal-routing.ts";
import { cosineDistance } from "./residuals.ts";
import { computeExpectedDebt } from "./measurement.ts";
import { computeDebtTrend } from "./residuals.ts";
import { healConcept, planHealConcept, type HealConceptDeps } from "./heal.ts";
import {
  applyLifecycleTarget,
  archiveConcept,
  mergeConcept,
  patchConcept,
  rebuildConcept,
  renameConcept,
  resolveConceptByNameCi,
  restoreConcept,
  splitConcept,
  type LifecycleDeps,
  type LifecycleResult,
} from "./concept-lifecycle.ts";
import { recomputeGraph } from "./graph.ts";
import {
  computeDebtSnapshot,
  conceptLiveStaleness,
  conceptPressure,
  describeConceptPriority,
  conceptDebtShare,
  type DebtSnapshot,
} from "./debt.ts";
import { computeAskDebtSnapshot } from "./ask-debt.ts";
import { webSearch } from "./web-search.ts";
import {
  recordUsage,
  usageFirstSeen,
  usageTotals,
  type LoreUsageReport,
  type UsageReporter,
} from "@/db/usage.ts";
import {
  ALL_PROVIDERS,
  CATALOG_NEEDS_KEY,
  catalogNeedsBaseUrl,
  hasCatalog,
  hasUsage,
  getProviderUsage,
  getProviderModel,
  listAllProviderModels,
  listProviderModels,
  type ListProviderModelsOptions,
  type ProviderModelPage,
  type ProviderModel,
  type ProviderStatus,
  type ProviderUsage,
} from "./provider-models.ts";
import type {
  Registry,
  FileRef,
  ScanResult,
  ScanStats,
  SymbolSearchResult,
  SymbolRow,
  SymbolKind,
  ConceptBindingSummary,
  SymbolDriftResult,
  CoverageReport,
  BootstrapPlan,
  NarrativeTrailEntry,
  NarrativeTrailResult,
  IngestResult,
} from "@/types/index.ts";
import type {
  SchemaRepairOptions,
  SchemaRepairResult,
  PruneOrphansResult,
  VacuumResult,
} from "@/db/index.ts";
import { getHeadSha } from "@/engine/git.ts";
import { buildConceptHealthNeighbors, computeConceptHealthSignals } from "./concept-health.ts";
import { ulid } from "ulid";
import { computeSuggestions } from "./suggest.ts";
import type { SuggestResult, SuggestionKind } from "@/types/index.ts";
import { scanProject, rescanProject } from "./scanner.ts";
import { discoverFiles } from "./file-discovery.ts";
import {
  extractBindingsForConcepts,
  pruneOrphanedBindings,
  autoBindSemantic,
} from "./binding-extraction.ts";
import type { AutoBindResult } from "./binding-extraction.ts";
import {
  searchSymbols,
  getSymbolsForFilePath,
  findSymbolsByName,
  getSymbolCount,
} from "@/db/symbols.ts";
import {
  getSourceFileCount,
  getSourceFileLanguageCounts,
  getLastScannedAt,
} from "@/db/source-files.ts";
import {
  getBindingSummariesForConcept,
  deleteConceptSymbol,
  findBoundSymbolsByName,
  upsertConceptSymbol,
  getDriftedBindings,
  getBindingCounts,
  getUncoveredSymbols,
  getFileCoverage,
  getCoverageStats,
} from "@/db/concept-symbols.ts";
import { computeBootstrapPlan } from "./bootstrap.ts";
import { ingestDocFile, ingestTextFiles } from "./ingester.ts";
import { discoverTextFiles } from "./file-discovery-text.ts";
import { getSourceChunkCount, getDocLaneStats, getJournalEntryCount } from "@/db/chunks.ts";
import {
  countEmbeddingsByModel,
  countSymbolEmbeddingLane,
  staleSymbolEmbeddingModels,
} from "@/db/embeddings.ts";
import { countAllOrphanedRows } from "@/db/chunks.ts";

interface CloseJobPayload {
  mergeStrategy?: MergeStrategy;
  fromResultId?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((_resolve) => setTimeout(_resolve, ms));
}

interface PromptPreviewResult {
  key: GenerationPromptKey;
  guidance: string;
  system: string;
}

function hasStaleSignals(result: QueryResult): boolean {
  if (
    result.results.some((item) => {
      return (
        item.warning != null ||
        (item.meta.staleness ?? 0) > 0.4 ||
        item.meta.symbol_drift === "drifted"
      );
    })
  ) {
    return true;
  }
  return (
    result.executive_summary?.claims?.some((claim) => (claim.max_staleness ?? 0) > 0.4) ?? false
  );
}

function buildNextActions(result: QueryResult): QueryNextAction[] {
  const actions: QueryNextAction[] = [];
  const topResult = result.results[0];
  if (topResult) {
    actions.push({
      kind: "show",
      primary: true,
      concept: topResult.concept,
      reason: hasStaleSignals(result)
        ? "Inspect the canonical concept before acting because this answer carries drift or staleness signals."
        : "Inspect the canonical concept before making a change.",
    });
  } else {
    actions.push({
      kind: "ingest",
      primary: true,
      reason: "No concept matched cleanly. Refresh the lake before trusting an empty answer.",
    });
  }

  actions.push({
    kind: "recall",
    primary: false,
    section: "sources",
    reason: "Expand the sources, file refs, and bindings behind this answer.",
  });

  const trailNarrative =
    result.journal_results && result.journal_results.length === 1
      ? result.journal_results[0]?.narrative_name
      : null;
  if (trailNarrative) {
    actions.push({
      kind: "trail",
      primary: false,
      narrative: trailNarrative,
      reason: "Replay the strongest investigation trail behind this answer.",
    });
  }

  return actions.slice(0, 3);
}

export class LoreEngine {
  private readonly globalConfig: LoreConfig;
  private registry: Registry;
  private readonly dbs: Map<string, Database> = new Map();
  private readonly programmaticOverrides?: Partial<LoreConfig>;

  constructor(configOverrides?: Partial<LoreConfig>) {
    this.programmaticOverrides = configOverrides;
    this.globalConfig = resolveConfig(configOverrides);
    mkdirSync(this.globalConfig.lore_root, { recursive: true });
    this.registry = loadRegistry(this.globalConfig.lore_root);
  }

  /** Get (or open) the per-project database for a given lore path. */
  private dbFor(lorePath: string): Database {
    let db = this.dbs.get(lorePath);
    if (!db) {
      mkdirSync(lorePath, { recursive: true });
      db = openDb(join(lorePath, "lore.db"));
      runMigrations(db);
      // Deletes leave free pages in the file. Reclaim them here, where no
      // transaction is open and no work depends on the database yet. The check
      // is three pragmas; the rewrite only runs when the file is mostly free.
      reclaimFreeSpace(db);
      this.dbs.set(lorePath, db);
    }
    return db;
  }

  /** Resolve config with per-lore-mind overrides from local file */
  private configFor(entry?: RegistryEntry): LoreConfig {
    const loreMindConfig = entry
      ? (loadLocalConfig(entry.code_path) as Record<string, unknown>)
      : undefined;
    const resolved = resolveConfig(
      this.programmaticOverrides,
      loreMindConfig as Partial<LoreConfig> | undefined,
    );
    const providers = this.registry.providers ?? {};

    const effective: LoreConfig = {
      ...resolved,
      ai: {
        ...resolved.ai,
        embedding: { ...resolved.ai.embedding },
        generation: { ...resolved.ai.generation },
        ...(resolved.ai.search
          ? {
              search: {
                ...resolved.ai.search,
                ...(resolved.ai.search.rerank ? { rerank: { ...resolved.ai.search.rerank } } : {}),
                ...(resolved.ai.search.executive_summary
                  ? { executive_summary: { ...resolved.ai.search.executive_summary } }
                  : {}),
              },
            }
          : {}),
      },
    };

    const applyCredential = (
      provider: SharedProvider | undefined,
      target: { api_key?: string; base_url?: string },
      loreMindApiKeyPath: string,
      loreMindBaseUrlPath: string,
    ) => {
      if (!provider) return;
      const credential = providers[provider];
      if (!credential) return;
      const hasLoreMindApiKeyOverride = loreMindConfig
        ? getDeepValue(loreMindConfig, loreMindApiKeyPath) !== undefined
        : false;
      const hasLoreMindBaseUrlOverride = loreMindConfig
        ? getDeepValue(loreMindConfig, loreMindBaseUrlPath) !== undefined
        : false;
      if (!hasLoreMindApiKeyOverride && credential.api_key !== undefined) {
        target.api_key = credential.api_key;
      }
      if (!hasLoreMindBaseUrlOverride && credential.base_url !== undefined) {
        target.base_url = credential.base_url;
      }
    };

    applyCredential(
      effective.ai.embedding.provider,
      effective.ai.embedding,
      "ai.embedding.api_key",
      "ai.embedding.base_url",
    );
    applyCredential(
      effective.ai.generation.provider,
      effective.ai.generation,
      "ai.generation.api_key",
      "ai.generation.base_url",
    );

    const rerank = effective.ai.search?.rerank;
    if (rerank) {
      const rerankProvider = rerank.provider ?? "cohere";
      applyCredential(
        rerankProvider,
        rerank,
        "ai.search.rerank.api_key",
        "ai.search.rerank.base_url",
      );
    }

    const summary = effective.ai.search?.executive_summary;
    if (summary) {
      const summaryProvider = summary.provider ?? effective.ai.generation.provider;
      applyCredential(
        summaryProvider,
        summary,
        "ai.search.executive_summary.api_key",
        "ai.search.executive_summary.base_url",
      );
    }

    return effective;
  }

  private recordInteraction(
    db: Database,
    eventType: "ask" | "recall" | "show" | "trail" | "open_narrative" | "close_narrative" | "score",
    opts?: {
      resultId?: string | null;
      subject?: string | null;
      meta?: Record<string, unknown> | null;
      createdAt?: string;
    },
  ): void {
    try {
      insertInteractionEvent(db, {
        eventType,
        resultId: opts?.resultId,
        subject: opts?.subject,
        meta: opts?.meta,
        createdAt: opts?.createdAt,
      });
    } catch {
      // interaction_events may not exist yet on pre-migration lore DBs — non-fatal
    }
  }

  private async drainPendingCloseMaintenance(
    entry: RegistryEntry,
    db: Database,
    maxJobs: number = 1,
  ): Promise<{ completed: number; failed: number }> {
    if (maxJobs <= 0) return { completed: 0, failed: 0 };

    const ownerBase = `${process.pid}:${ulid()}`;
    let completed = 0;
    let failed = 0;
    let config: LoreConfig | null = null;
    let embedder: Embedder | null = null;
    let generator: Generator | null = null;
    let codeEmbedder: Embedder | null = null;

    for (let index = 0; index < maxJobs; index++) {
      const owner = `${ownerBase}:${index}`;
      const job = claimCloseMaintenanceJob(db, {
        lorePath: entry.lore_path,
        owner,
        leaseTtlMs: 60_000,
        maxRetries: 1,
      });
      if (!job) break;

      try {
        const payload = JSON.parse(job.payload_json) as CloseMaintenancePayload;
        config ??= this.configFor(entry);
        if (!embedder || !generator) {
          [embedder, generator, codeEmbedder] = await Promise.all([
            this.embedderFor(config, entry),
            this.generatorFor(config, entry),
            this.codeEmbedderFor(config, entry),
          ]);
        }
        const { rescanFailed } = await runCloseMaintenanceJob(
          db,
          payload,
          config,
          embedder,
          generator,
          codeEmbedder,
        );
        completeCloseMaintenanceJob(db, {
          lorePath: entry.lore_path,
          id: job.id,
          owner,
          note:
            rescanFailed.length > 0
              ? `refresh incomplete: ${rescanFailed.length} file(s) failed rescan: ${rescanFailed.join(", ")}`
              : undefined,
        });
        completed += 1;
      } catch (error) {
        const failure = failCloseMaintenanceJob(db, {
          lorePath: entry.lore_path,
          id: job.id,
          owner,
          error: error instanceof Error ? error.message : String(error),
          retry: true,
          maxRetries: 1,
        });
        if (failure.status === "failed") {
          failed += 1;
        }
      }
    }

    return { completed, failed };
  }

  private serializeCloseJob(row: {
    id: string;
    narrative_id: string;
    narrative_name: string;
    status: CloseJob["status"];
    owner: string | null;
    attempt: number;
    lease_expires_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }): CloseJob {
    return {
      id: row.id,
      narrative_id: row.narrative_id,
      narrative_name: row.narrative_name,
      status: row.status,
      owner: row.owner,
      attempt: row.attempt,
      lease_expires_at: row.lease_expires_at,
      last_error: row.last_error,
      created_at: row.created_at,
      updated_at: row.updated_at,
      completed_at: row.completed_at,
    };
  }

  private readCloseJobDetail(entry: RegistryEntry, jobId: string): CloseJobDetail {
    const { db } = this.resolveLoreMind(entry.code_path);
    const row = getCloseJob(db, { lorePath: entry.lore_path, id: jobId });
    if (!row) {
      throw new LoreError("CLOSE_JOB_NOT_FOUND", `No close job '${jobId}' exists`);
    }
    return {
      job: this.serializeCloseJob(row),
      result: row.close_result_json
        ? (JSON.parse(row.close_result_json) as CloseResult)
        : undefined,
    };
  }

  private buildQueuedCloseResult(row: {
    id: string;
    narrative_id: string;
    narrative_name: string;
    status: CloseJob["status"];
    owner: string | null;
    attempt: number;
    lease_expires_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  }): CloseResult {
    return {
      mode: "merge",
      integrated: false,
      commit_id: null,
      narrative_status: "closing",
      concepts_updated: [],
      concepts_created: [],
      conflicts: [],
      impact: {
        summary: `Narrative '${row.narrative_name}' was queued for background close.`,
        debt_before: null,
        debt_after: null,
      },
      close_job: this.serializeCloseJob(row),
      follow_up: `Use 'lore wait ${row.id}' to block on completion or 'lore job ${row.id}' to inspect progress.`,
    };
  }

  private buildFinalCloseSummary(debtBefore: number | null, debtAfter: number | null): string {
    if (debtBefore == null || debtAfter == null) {
      return "Close completed.";
    }
    return `Debt ${debtAfter < debtBefore ? "reduced" : "increased"} ${Math.abs(((debtBefore - debtAfter) / (debtBefore || 1)) * 100).toFixed(0)}%.`;
  }

  private finalizeCloseResult(
    db: Database,
    lorePath: string,
    result: CloseResult,
    opts?: { maintenanceStatus?: "completed" | "failed"; maintenanceError?: string | null },
  ): CloseResult {
    const closeJob = result.close_job;
    const maintenanceCounts = getCloseMaintenanceJobCounts(db, { lorePath });
    const maintenance =
      result.maintenance == null
        ? undefined
        : {
            ...result.maintenance,
            status: opts?.maintenanceStatus ?? "completed",
            pending_jobs: maintenanceCounts.queued + maintenanceCounts.leased,
            failed_jobs: maintenanceCounts.failed,
            note:
              opts?.maintenanceStatus === "failed" && opts.maintenanceError
                ? `Maintenance failed: ${opts.maintenanceError}`
                : undefined,
          };
    const debtAfter =
      getManifest(db)?.debt ?? result.impact.debt_after ?? result.impact.debt_before;
    return {
      ...result,
      narrative_status: "closed",
      close_job: closeJob,
      impact: {
        ...result.impact,
        summary: this.buildFinalCloseSummary(result.impact.debt_before, debtAfter),
        debt_after: debtAfter,
      },
      maintenance,
      follow_up:
        opts?.maintenanceStatus === "failed" && opts.maintenanceError
          ? opts.maintenanceError
          : result.follow_up,
    };
  }

  private cachedEmbedder?: Embedder;
  private cachedGenerator?: Generator;
  private embedCacheKey?: string;
  private genCacheKey?: string;
  private cachedCodeEmbedder?: Embedder | null;
  private codeCacheKey?: string;

  /**
   * A usage sink bound to one mind's database.
   *
   * Clients are cached, and read paths run concurrently across minds, so the
   * sink has to travel with the client rather than be read from engine state:
   * a shared mutable "current lore" would file one project's spend under
   * another's. That is also why lore_path is back in the cache keys.
   */
  private usageSinkFor(entry?: RegistryEntry): UsageReporter | undefined {
    if (!entry) return undefined;
    const db = this.dbs.get(entry.lore_path);
    if (!db) return undefined;
    return (event) => recordUsage(db, event);
  }

  private async embedderFor(config: LoreConfig, entry?: RegistryEntry): Promise<Embedder> {
    const key = JSON.stringify({
      provider: config.ai.embedding.provider,
      model: config.ai.embedding.model,
      base_url: config.ai.embedding.base_url ?? "",
      api_key: config.ai.embedding.api_key ?? "",
      lorePath: entry?.lore_path ?? "",
    });
    if (!this.cachedEmbedder || this.embedCacheKey !== key) {
      this.cachedEmbedder = await Embedder.create(config, this.usageSinkFor(entry));
      this.embedCacheKey = key;
    }
    return this.cachedEmbedder;
  }

  private async codeEmbedderFor(
    config: LoreConfig,
    entry?: RegistryEntry,
  ): Promise<Embedder | null> {
    const code = config.ai.embedding.code;
    if (!code) return null;
    const key = JSON.stringify({
      provider: code.provider ?? config.ai.embedding.provider,
      model: code.model,
      base_url: code.base_url ?? config.ai.embedding.base_url ?? "",
      api_key: code.api_key ?? config.ai.embedding.api_key ?? "",
      lorePath: entry?.lore_path ?? "",
    });
    if (this.cachedCodeEmbedder === undefined || this.codeCacheKey !== key) {
      this.cachedCodeEmbedder = await Embedder.createForCode(config, this.usageSinkFor(entry));
      this.codeCacheKey = key;
    }
    return this.cachedCodeEmbedder;
  }

  private async generatorFor(config: LoreConfig, entry?: RegistryEntry): Promise<Generator> {
    const key = JSON.stringify({
      provider: config.ai.generation.provider,
      model: config.ai.generation.model,
      base_url: config.ai.generation.base_url ?? "",
      api_key: config.ai.generation.api_key ?? "",
      reasoning: config.ai.generation.reasoning ?? "none",
      prompts: config.ai.generation.prompts,
      lorePath: entry?.lore_path ?? "",
    });
    if (!this.cachedGenerator || this.genCacheKey !== key) {
      this.cachedGenerator = await Generator.create(config, this.usageSinkFor(entry));
      this.genCacheKey = key;
    }
    return this.cachedGenerator;
  }

  // ─── Repo Resolution ─────────────────────────────────
  private resolveLoreMind(codePath?: string): { name: string; entry: RegistryEntry; db: Database } {
    const cwd = codePath ? resolve(codePath) : process.cwd();
    const found = findLoreMindByCodePath(this.registry, cwd);
    if (!found) {
      throw new LoreError(
        "LORE_NOT_REGISTERED",
        `This path is not registered as a lore (${cwd}). Run 'lore init' first.`,
      );
    }
    return { ...found, db: this.dbFor(found.entry.lore_path) };
  }

  /** Close all cached database connections. */
  shutdown(): void {
    for (const db of this.dbs.values()) {
      db.close();
    }
    this.dbs.clear();
  }

  // ─── Public API ───────────────────────────────────────

  async register(codePath: string, name?: string): Promise<RegisterResult> {
    const absPath = resolve(codePath);
    const config = this.configFor();
    const loreMindName = name ?? basename(absPath);
    const flPath = makeLoreMindPath(loreMindName, config.lore_root);

    // Exact match only: an ancestor match here would silently alias a nested
    // project to its parent mind instead of registering it.
    const existing = findLoreMindByExactPath(this.registry, absPath);
    if (existing) {
      return { lore_path: existing.entry.lore_path, ready: true };
    }

    await ensureDir(flPath);
    await ensureDir(`${flPath}/main`);
    seedGlobalConfigIfAbsent();
    this.registry = addLoreMind(config.lore_root, this.registry, loreMindName, absPath, flPath);

    // Ensure DB is created and migrated
    const db = this.dbFor(flPath);

    // Initial source code scan
    let scan: ScanResult | undefined;
    try {
      scan = await scanProject(db, absPath, flPath);
    } catch {
      // Scan failure is non-fatal — lore is still usable without source symbols
    }

    return { lore_path: flPath, ready: true, scan };
  }

  async open(
    narrativeName: string,
    intent: string,
    opts?: {
      codePath?: string;
      resolveDangling?: ResolveDangling | ResolveDangling[];
      targets?: NarrativeTarget[];
      fromResultId?: string;
    },
  ): Promise<OpenResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const result = await openNarrative(
      db,
      entry.lore_path,
      narrativeName,
      intent,
      config,
      await this.embedderFor(config, entry),
      opts?.resolveDangling,
      opts?.targets,
    );
    this.recordInteraction(db, "open_narrative", {
      resultId: opts?.fromResultId,
      subject: narrativeName,
      meta: { intent },
    });
    return result;
  }

  async log(
    narrativeName: string,
    text: string,
    opts: {
      topics?: string[];
      codePath?: string;
      refs?: FileRef[];
      concepts: string[];
      symbols?: string[];
    },
  ): Promise<LogResult> {
    const { entry, db } = this.resolveLoreMind(opts.codePath);
    const config = this.configFor(entry);
    return logEntry(db, entry.lore_path, narrativeName, text, config, {
      topics: opts.topics,
      codePath: entry.code_path,
      refs: opts.refs,
      concepts: opts.concepts,
      symbols: opts.symbols,
    });
  }

  /**
   * Capture a finding without naming a narrative or a concept.
   *
   * Everything `lore write` demands is worked out here: the narrative from
   * what is open, the concept from the note text. The stored entry is the same
   * shape either way, so a note needs no second pass to become useful and the
   * close reads it exactly as it reads a written entry.
   */
  async note(text: string, opts?: NoteOptions): Promise<NoteResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);

    let narrativeName = opts?.narrative;
    let openedInbox = false;
    if (!narrativeName) {
      const choice = chooseNarrative(db);
      if (choice.kind === "open") {
        narrativeName = choice.narrative.name;
      } else {
        narrativeName = INBOX_NARRATIVE;
        // Opening it here is what keeps a note from ever being refused for
        // want of somewhere to go.
        if (!getOpenNarrativeByName(db, INBOX_NARRATIVE)) {
          await this.open(INBOX_NARRATIVE, INBOX_INTENT, { codePath: opts?.codePath });
          openedInbox = true;
        }
      }
    }

    const narrative = getWritableNarrativeByName(db, narrativeName);
    if (!narrative) {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `Narrative '${narrativeName}' is not open.`);
    }

    // An explicit concept skips routing entirely: the caller already decided,
    // and journal-routing validates it against the narrative's targets.
    let concepts = opts?.concepts ?? [];
    let routing: ConceptRouting | null = null;
    if (concepts.length === 0) {
      routing = await routeConcept(
        db,
        await this.embedderFor(config, entry),
        config,
        narrative,
        text,
      );
      if (routing.kind !== "inherit") concepts = [routing.concept];
    }

    const logged = await logEntry(db, entry.lore_path, narrativeName, text, config, {
      codePath: entry.code_path,
      refs: opts?.refs,
      concepts,
      symbols: opts?.symbols,
      topics: opts?.topics,
    });

    return {
      ...logged,
      narrative: narrativeName,
      opened_narrative: openedInbox,
      routed_concept: routing?.kind === "routed" ? routing.concept : null,
    };
  }

  private async runQuery(
    text: string,
    opts?: QueryOptions,
    internal?: {
      disablePerLoreMindSummary?: boolean;
      disableWeb?: boolean;
      skipTelemetry?: boolean;
    },
  ): Promise<QueryResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const askId = ulid();
    const askTracer =
      opts?.debug || config.debug?.ask?.trace ? new AskTracer(entry.lore_path, askId) : undefined;
    opts?.onProgress?.("preparing models");
    const summaryCfg = config.ai.search?.executive_summary;
    const summaryEnabled = internal?.disablePerLoreMindSummary
      ? false
      : (summaryCfg?.enabled ?? true);
    const summaryProvider = summaryCfg?.provider ?? config.ai.generation.provider;
    const summaryModel = summaryCfg?.model ?? config.ai.generation.model;
    const summaryApiKey = summaryCfg?.api_key ?? config.ai.generation.api_key;
    const summaryBaseUrl = summaryCfg?.base_url ?? config.ai.generation.base_url;
    const summaryReasoning =
      summaryCfg?.reasoning ?? config.ai.generation.reasoning_overrides?.executive_summary;
    const summaryMaxMatches = summaryCfg?.max_matches ?? 10;
    const summaryMaxChars = summaryCfg?.max_chars ?? 1600;
    const summarySourceMaxChars = summaryCfg?.source_max_chars ?? 6000;

    const summaryGeneratorPromise = summaryEnabled
      ? (() => {
          const summaryNeedsOverride =
            summaryProvider !== config.ai.generation.provider ||
            summaryModel !== config.ai.generation.model ||
            summaryApiKey !== config.ai.generation.api_key ||
            summaryBaseUrl !== config.ai.generation.base_url;
          const summaryGenConfig = !summaryNeedsOverride
            ? config
            : {
                ...config,
                ai: {
                  ...config.ai,
                  generation: {
                    ...config.ai.generation,
                    provider: summaryProvider,
                    model: summaryModel,
                    api_key: summaryApiKey,
                    base_url: summaryBaseUrl,
                  },
                },
              };
          return this.generatorFor(summaryGenConfig, entry);
        })()
      : Promise.resolve(undefined);

    opts?.onProgress?.("preparing embedder");
    const [summaryGenerator, embedder, codeEmbedder] = await Promise.all([
      summaryGeneratorPromise,
      this.embedderFor(config, entry),
      this.codeEmbedderFor(config, entry),
    ]);

    // If source chunks exist, a code model is required — no silent fallback
    const sourceChunkCount =
      db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM chunks WHERE fl_type = 'source'`,
        )
        .get()?.count ?? 0;
    if (sourceChunkCount > 0 && !codeEmbedder) {
      throw new LoreError(
        "CODE_MODEL_NOT_CONFIGURED",
        `${sourceChunkCount} source chunks are indexed but no code embedding model is configured. ` +
          `Run: lore mind config set ai.embedding.code.model <model>`,
      );
    }

    // Skip the code lane if a code model is configured but no source embeddings exist yet.
    // Avoids paying the full API round-trip cost (typically ~400ms) for zero results.
    let effectiveCodeEmbedder = codeEmbedder;
    if (codeEmbedder && config.ai.embedding.code?.model) {
      const hasCodeEmbeddings =
        db
          .query<{ c: number }, [string]>(
            `SELECT COUNT(*) c FROM embeddings e
           JOIN chunks ch ON e.chunk_id = ch.id
           WHERE ch.fl_type = 'source' AND e.model = ? LIMIT 1`,
          )
          .get(config.ai.embedding.code.model)?.c ?? 0;
      if (!hasCodeEmbeddings) {
        effectiveCodeEmbedder = null;
        askTracer?.log("lane.code", { skipped: true, reason: "no source embeddings" });
      }
    }

    const askDebtConcepts = getActiveConcepts(db);
    const askDebtManifest = getManifest(db);
    const askDebtRaw = await computeDebtSnapshot(entry, db, askDebtConcepts, askDebtManifest, {
      stalenessDays: config.thresholds.staleness_days,
    });
    const askDebtSnapshot = computeAskDebtSnapshot({
      db,
      entry,
      config,
      concepts: askDebtConcepts,
      debtSnapshot: askDebtRaw,
    });

    const result = await queryConcepts(db, text, config, embedder, {
      search: internal?.disableWeb ? false : opts?.search,
      brief: opts?.brief,
      concise: opts?.concise,
      codePath: entry.code_path,
      mode: opts?.mode,
      scopes: opts?.scopes,
      summary_generator: summaryGenerator,
      executive_summary: {
        enabled: summaryEnabled,
        model: summaryModel,
        reasoning: summaryReasoning,
        max_matches: summaryMaxMatches,
        max_chars: summaryMaxChars,
        source_max_chars: summarySourceMaxChars,
        system_prompt: summaryCfg?.system_prompt,
        concise_system_prompt: summaryCfg?.concise_system_prompt,
      },
      onProgress: opts?.onProgress,
      codeEmbedder: effectiveCodeEmbedder,
      tracer: askTracer,
      ask_debt: {
        score: askDebtSnapshot.debt,
        band: askDebtSnapshot.band,
      },
    });

    // Cache the result with a ULID for recall (shared with ask trace filename when tracing is on)
    result.result_id = askId;
    result.next_actions = buildNextActions(result);
    if (!internal?.skipTelemetry) {
      try {
        insertQueryCache(db, {
          id: askId,
          queryText: text,
          resultJson: JSON.stringify(result),
          createdAt: new Date().toISOString(),
        });
      } catch {
        // query_cache table may not exist yet — non-fatal
      }
      this.recordInteraction(db, "ask", {
        resultId: askId,
        subject: text,
        meta: {
          primary_action: result.next_actions[0]?.kind,
          stale_warning: hasStaleSignals(result),
          // Consult set for the debt distribution p(c) (spec §8): each pack
          // concept is consulted at weight 1/|pack|.
          pack_concepts: result.executive_summary?.pack_concepts,
        },
      });
    }

    try {
      askTracer?.flush();
      if (askTracer && opts?.debug) result.debug_trace_path = askTracer.outputPath;
    } catch {}

    return result;
  }

  async query(text: string, opts?: QueryOptions): Promise<QueryResult> {
    return this.runQuery(text, opts);
  }

  async queryForOrchestration(
    text: string,
    opts?: OrchestrationQueryOptions,
  ): Promise<QueryResult> {
    return this.runQuery(text, opts, {
      disablePerLoreMindSummary: opts?.disable_per_lore_mind_summary,
      disableWeb: opts?.disable_web,
      skipTelemetry: true,
    });
  }

  recallResult(
    resultId: string,
    opts?: { codePath?: string; section?: RecallSection },
  ): RecallResult | null {
    const { db } = this.resolveLoreMind(opts?.codePath);
    try {
      const row = getQueryCache(db, resultId);
      if (!row) return null;
      this.recordInteraction(db, "recall", {
        resultId,
        subject: opts?.section ?? "full",
        meta: { section: opts?.section ?? "full" },
      });
      return {
        result_id: row.id,
        query_text: row.query_text,
        result: JSON.parse(row.result_json) as QueryResult,
        score: row.score,
        scored_by: row.scored_by,
        created_at: row.created_at,
      };
    } catch {
      return null;
    }
  }

  scoreResult(
    resultId: string,
    score: number,
    opts?: { codePath?: string; scoredBy?: string },
  ): void {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const ok = scoreQueryCache(db, resultId, score, opts?.scoredBy);
    if (!ok) {
      throw new LoreError("QUERY_CACHE_NOT_FOUND", `No cached result with id ${resultId}`);
    }
    this.recordInteraction(db, "score", {
      resultId,
      subject: String(score),
      meta: { score },
    });
  }

  async searchWeb(query: string, opts?: { codePath?: string }): Promise<WebSearchResult[]> {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    return webSearch(query, config);
  }

  async summarizeMatches(
    query: string,
    matches: Array<{ concept: string; score: number; content: string; lore_mind?: string }>,
    opts?: {
      codePath?: string;
      maxMatches?: number;
      maxChars?: number;
      timeoutMs?: number;
      reasoning?: ReasoningLevel;
      systemPrompt?: string;
    },
  ): Promise<ExecutiveSummary | undefined> {
    if (matches.length === 0) return undefined;

    const { entry } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const summaryCfg = config.ai.search?.executive_summary;
    const summaryEnabled = summaryCfg?.enabled ?? true;
    if (!summaryEnabled) return undefined;

    const summaryProvider = summaryCfg?.provider ?? config.ai.generation.provider;
    const summaryModel = summaryCfg?.model ?? config.ai.generation.model;
    const summaryApiKey = summaryCfg?.api_key ?? config.ai.generation.api_key;
    const summaryBaseUrl = summaryCfg?.base_url ?? config.ai.generation.base_url;
    const summaryReasoning =
      opts?.reasoning ??
      summaryCfg?.reasoning ??
      config.ai.generation.reasoning_overrides?.executive_summary;
    const summaryMaxMatches = Math.max(1, opts?.maxMatches ?? summaryCfg?.max_matches ?? 10);
    const summaryMaxChars = Math.max(200, opts?.maxChars ?? summaryCfg?.max_chars ?? 1600);
    const timeoutMs = opts?.timeoutMs ?? config.ai.search?.timeouts?.executive_summary_ms;

    const summaryNeedsOverride =
      summaryProvider !== config.ai.generation.provider ||
      summaryModel !== config.ai.generation.model ||
      summaryApiKey !== config.ai.generation.api_key ||
      summaryBaseUrl !== config.ai.generation.base_url;
    const summaryGenConfig = !summaryNeedsOverride
      ? config
      : {
          ...config,
          ai: {
            ...config.ai,
            generation: {
              ...config.ai.generation,
              provider: summaryProvider,
              model: summaryModel,
              api_key: summaryApiKey,
              base_url: summaryBaseUrl,
            },
          },
        };
    const generator = await this.generatorFor(summaryGenConfig, entry);

    return generateExecutiveSummary(
      generator,
      query,
      matches.slice(0, summaryMaxMatches).map((m) => ({
        concept: m.concept,
        score: m.score,
        content: m.content.slice(0, summaryMaxChars),
        lore_mind: m.lore_mind,
      })),
      matches.length,
      summaryReasoning,
      timeoutMs,
      {
        systemPrompt: opts?.systemPrompt,
        codePath: opts?.codePath,
      },
    );
  }

  private lifecycleDeps(entry: RegistryEntry, db: Database, config: LoreConfig): LifecycleDeps {
    return {
      db,
      lorePath: entry.lore_path,
      embeddingModel: config.ai.embedding.model,
      getEmbedder: () => this.embedderFor(config, entry),
      getGenerator: () => this.generatorFor(config, entry),
    };
  }

  private buildLifecycleTargetHandler(
    entry: RegistryEntry,
    db: Database,
    config: LoreConfig,
  ): (target: NarrativeTarget) => Promise<void> {
    const deps = this.lifecycleDeps(entry, db, config);
    return async (target: NarrativeTarget): Promise<void> => {
      // Result discarded — the close job reports via its own CloseResult.
      await applyLifecycleTarget(deps, target);
    };
  }

  private async executeCloseJob(
    entry: RegistryEntry,
    db: Database,
    job: NonNullable<ReturnType<typeof getCloseJob>>,
  ): Promise<{
    status: "done" | "failed";
    result?: CloseResult;
    maintenance_jobs_processed: number;
    maintenance_jobs_failed: number;
  }> {
    const payload = JSON.parse(job.payload_json) as CloseJobPayload;
    const config = this.configFor(entry);
    const [embedder, generator, codeEmbedder] = await Promise.all([
      this.embedderFor(config, entry),
      this.generatorFor(config, entry),
      this.codeEmbedderFor(config, entry),
    ]);

    try {
      const result = await closeNarrativeOp(
        db,
        entry.lore_path,
        job.narrative_name,
        config,
        embedder,
        generator,
        entry.code_path,
        {
          lifecycleTargetHandler: this.buildLifecycleTargetHandler(entry, db, config),
          mergeStrategy: payload.mergeStrategy,
          codeEmbedder,
        },
      );
      this.recordInteraction(db, "close_narrative", {
        resultId: payload.fromResultId,
        subject: job.narrative_name,
        meta: { mode: "merge", commit_id: result.commit_id },
      });

      let maintenanceJobsProcessed = 0;
      let maintenanceJobsFailed = 0;
      let finalResult = result;

      if (result.maintenance?.job_id) {
        while (true) {
          const maintenanceJob = getCloseMaintenanceJob(db, {
            lorePath: entry.lore_path,
            id: result.maintenance.job_id,
          });
          if (!maintenanceJob || maintenanceJob.status === "done") {
            finalResult = this.finalizeCloseResult(db, entry.lore_path, result, {
              maintenanceStatus: "completed",
            });
            break;
          }
          if (maintenanceJob.status === "failed") {
            maintenanceJobsFailed += 1;
            finalResult = this.finalizeCloseResult(db, entry.lore_path, result, {
              maintenanceStatus: "failed",
              maintenanceError: maintenanceJob.last_error,
            });
            break;
          }
          const drained = await this.drainPendingCloseMaintenance(entry, db, 1);
          maintenanceJobsProcessed += drained.completed;
          maintenanceJobsFailed += drained.failed;
          if (drained.completed === 0 && drained.failed === 0) {
            await sleep(50);
          }
        }
      } else {
        finalResult = this.finalizeCloseResult(db, entry.lore_path, result);
      }

      if (maintenanceJobsFailed > 0) {
        failCloseJob(db, {
          lorePath: entry.lore_path,
          id: job.id,
          owner: job.owner ?? undefined,
          error: finalResult.maintenance?.note ?? "Close maintenance failed",
          retry: false,
          result: finalResult,
        });
        return {
          status: "failed",
          result: finalResult,
          maintenance_jobs_processed: maintenanceJobsProcessed,
          maintenance_jobs_failed: maintenanceJobsFailed,
        };
      }

      completeCloseJob(db, {
        lorePath: entry.lore_path,
        id: job.id,
        owner: job.owner ?? undefined,
        result: finalResult,
      });
      return {
        status: "done",
        result: finalResult,
        maintenance_jobs_processed: maintenanceJobsProcessed,
        maintenance_jobs_failed: maintenanceJobsFailed,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const narrative = getNarrative(db, job.narrative_id);
      if (narrative?.status === "closing") {
        failNarrativeClose(db, narrative.id);
      }
      failCloseJob(db, {
        lorePath: entry.lore_path,
        id: job.id,
        owner: job.owner ?? undefined,
        error: message,
        retry: false,
      });
      return {
        status: "failed",
        maintenance_jobs_processed: 0,
        maintenance_jobs_failed: 0,
      };
    }
  }

  private async runCloseWorkerInternal(
    entry: RegistryEntry,
    db: Database,
    opts?: { watch?: boolean; pollMs?: number; targetJobId?: string; maxJobs?: number },
  ): Promise<CloseWorkerRunResult> {
    const mode = opts?.watch ? "watch" : "once";
    const ownerBase = `${process.pid}:${ulid()}`;
    const maxJobs = Math.max(1, Math.floor(opts?.maxJobs ?? Number.MAX_SAFE_INTEGER));
    let closeJobsProcessed = 0;
    let closeJobsFailed = 0;
    let maintenanceJobsProcessed = 0;
    let maintenanceJobsFailed = 0;
    let idlePolls = 0;
    let lastJobId: string | null = null;

    while (closeJobsProcessed + closeJobsFailed < maxJobs) {
      const owner = `${ownerBase}:${closeJobsProcessed + closeJobsFailed + idlePolls}`;
      const job = claimCloseJob(db, {
        lorePath: entry.lore_path,
        owner,
        leaseTtlMs: 120_000,
        maxRetries: 0,
        id: opts?.targetJobId,
      });
      if (job) {
        const leasedJob = { ...job, owner };
        const outcome = await this.executeCloseJob(entry, db, leasedJob);
        lastJobId = leasedJob.id;
        closeJobsProcessed += outcome.status === "done" ? 1 : 0;
        closeJobsFailed += outcome.status === "failed" ? 1 : 0;
        maintenanceJobsProcessed += outcome.maintenance_jobs_processed;
        maintenanceJobsFailed += outcome.maintenance_jobs_failed;
        if (opts?.targetJobId) {
          break;
        }
        continue;
      }

      const drained = await this.drainPendingCloseMaintenance(entry, db, Number.MAX_SAFE_INTEGER);
      if (drained.completed > 0 || drained.failed > 0) {
        maintenanceJobsProcessed += drained.completed;
        maintenanceJobsFailed += drained.failed;
        if (!opts?.watch && !opts?.targetJobId) {
          continue;
        }
      }

      if (!opts?.watch) {
        break;
      }

      idlePolls += 1;
      await sleep(Math.max(50, opts?.pollMs ?? 250));
    }

    // A close maintenance job rescans files and rewrites chunks, so it feeds
    // the Lance store the same superseded versions an ingest does. The worker
    // holds nobody waiting, unlike the drain a `lore close` runs itself.
    if (maintenanceJobsProcessed > 0) {
      await reclaimLanceSpace(lanceDir(entry.lore_path));
    }

    return {
      mode,
      close_jobs_processed: closeJobsProcessed,
      close_jobs_failed: closeJobsFailed,
      maintenance_jobs_processed: maintenanceJobsProcessed,
      maintenance_jobs_failed: maintenanceJobsFailed,
      idle_polls: idlePolls,
      last_job_id: lastJobId,
    };
  }

  private async waitForCloseJobCompletion(
    entry: RegistryEntry,
    jobId: string,
    opts?: { pollMs?: number; assist?: boolean },
  ): Promise<CloseResult> {
    while (true) {
      const detail = this.readCloseJobDetail(entry, jobId);
      if (detail.job.status === "done") {
        if (!detail.result) {
          throw new LoreError(
            "CLOSE_JOB_FAILED",
            `Close job '${jobId}' completed without a result`,
          );
        }
        return { ...detail.result, close_job: detail.job };
      }
      if (detail.job.status === "failed") {
        throw new LoreError(
          "CLOSE_JOB_FAILED",
          detail.job.last_error ?? `Close job '${jobId}' failed`,
          { job: detail.job, result: detail.result ?? null },
        );
      }
      if (opts?.assist) {
        const { db } = this.resolveLoreMind(entry.code_path);
        await this.runCloseWorkerInternal(entry, db, { targetJobId: jobId, maxJobs: 1 });
      }
      await sleep(Math.max(50, opts?.pollMs ?? 250));
    }
  }

  async close(
    narrativeName: string,
    opts?: {
      codePath?: string;
      mode?: "merge" | "discard";
      mergeStrategy?: MergeStrategy;
      fromResultId?: string;
      wait?: boolean;
      pollMs?: number;
    },
  ): Promise<CloseResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const mode = opts?.mode ?? "merge";

    if (mode === "discard") {
      const result = await discardNarrative(db, narrativeName);
      this.recordInteraction(db, "close_narrative", {
        resultId: opts?.fromResultId,
        subject: narrativeName,
        meta: { mode },
      });
      return result;
    }
    const narrative = getNarrativeByName(db, narrativeName);
    if (!narrative || narrative.status === "closed" || narrative.status === "abandoned") {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
    }

    const existingJob = getLatestPendingCloseJobForNarrative(db, {
      lorePath: entry.lore_path,
      narrativeId: narrative.id,
    });
    if (existingJob) {
      return opts?.wait
        ? this.waitForCloseJobCompletion(entry, existingJob.id, {
            pollMs: opts?.pollMs,
            assist: true,
          })
        : this.buildQueuedCloseResult(existingJob);
    }
    if (narrative.status === "closing") {
      throw new LoreError(
        "NARRATIVE_CLOSING",
        `Narrative '${narrativeName}' is already closing in the background`,
      );
    }

    const queued = db.transaction(() => {
      markNarrativeClosing(db, narrative.id);
      return queueCloseJob(db, {
        lorePath: entry.lore_path,
        narrativeId: narrative.id,
        narrativeName,
        payload: {
          mergeStrategy: opts?.mergeStrategy,
          fromResultId: opts?.fromResultId,
        } satisfies CloseJobPayload,
      });
    })();

    if (opts?.wait) {
      return this.waitForCloseJobCompletion(entry, queued.id, {
        pollMs: opts?.pollMs,
        assist: true,
      });
    }

    const job = getCloseJob(db, { lorePath: entry.lore_path, id: queued.id });
    if (!job) {
      throw new LoreError("CLOSE_JOB_NOT_FOUND", `Queued close job '${queued.id}' was not found`);
    }
    return this.buildQueuedCloseResult(job);
  }

  async listCloseJobs(opts?: { codePath?: string; limit?: number }): Promise<CloseJob[]> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return listCloseJobs(db, {
      lorePath: entry.lore_path,
      limit: opts?.limit,
    }).map((job) => this.serializeCloseJob(job));
  }

  async getCloseJobDetail(jobId: string, opts?: { codePath?: string }): Promise<CloseJobDetail> {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    return this.readCloseJobDetail(entry, jobId);
  }

  async waitForCloseJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<CloseResult> {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    return this.waitForCloseJobCompletion(entry, jobId, { pollMs: opts?.pollMs });
  }

  async runCloseWorker(opts?: {
    codePath?: string;
    watch?: boolean;
    pollMs?: number;
  }): Promise<CloseWorkerRunResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return this.runCloseWorkerInternal(entry, db, opts);
  }

  async status(opts?: { codePath?: string }): Promise<StatusResult> {
    const { name, entry, db } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db, entry.lore_path);
    const config = this.configFor(entry);
    const manifest = getManifest(db);
    const concepts = getActiveConcepts(db);
    const activeNarrativesList = getActiveNarratives(db);
    const danglingNarratives = getDanglingNarratives(db, config.thresholds.dangling_days);
    const closeMaintenance = getCloseMaintenanceJobCounts(db, { lorePath: entry.lore_path });
    const closeJobs = getCloseJobCounts(db, { lorePath: entry.lore_path });
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest, {
      stalenessDays: config.thresholds.staleness_days,
    });
    const { debt: rawDebt } = debtSnapshot;
    const debtPrevious = null;
    const debtChange = null;

    // Check embedding model mismatch. The count holds reachable embeddings
    // only. See countEmbeddingsByModel for what it drops, and why.
    const embeddingModels = countEmbeddingsByModel(db);
    const currentModel = config.ai.embedding.model;
    const currentCodeModel = config.ai.embedding.code?.model ?? null;
    const validModels = new Set([currentModel, ...(currentCodeModel ? [currentCodeModel] : [])]);
    const totalEmbeddings = embeddingModels.reduce((s, r) => s + r.cnt, 0);
    const matchingEmbeddings = embeddingModels
      .filter((r) => validModels.has(r.model))
      .reduce((s, r) => s + r.cnt, 0);
    const staleEmbeddings = totalEmbeddings - matchingEmbeddings;

    // The code lane writes two tables, and the count above reads one of them.
    // The symbol lane keeps its own figure: the two lanes go stale apart, they
    // cost different amounts to rebuild, and one combined number names neither.
    // The unit is symbols. A symbol that holds an old row and a current one
    // reads correctly, so only a symbol with no current-model row is stale.
    // With no code model configured, every embedded symbol is stale: binding
    // extraction needs that model to read the table at all.
    const symbolLane = countSymbolEmbeddingLane(db, currentCodeModel);
    const staleSymbolEmbeddings = symbolLane.embedded - symbolLane.currentModel;
    const orphanedRows = countAllOrphanedRows(db);
    // The Lance store grows on its own account: every rewrite leaves the old
    // data file behind. Reading it costs one manifest per table and a directory
    // walk, and a store that has never been built reports zero.
    const lanceSpace = await getLanceSpace(lanceDir(entry.lore_path));

    // Priorities: ranked by expected debt share p(c)·R(c) — the concepts whose
    // healing moves debt most — among those with R(c) or σ(c) worth acting on.
    // Reads the axes from the snapshot, never the persisted staleness column
    // (frozen at 0 by close, never advanced by maintenance).
    const priorityConcepts = concepts
      .filter(
        (c) =>
          conceptPressure(c, debtSnapshot) > 0.3 || conceptLiveStaleness(c, debtSnapshot) > 0.5,
      )
      .sort((a, b) => conceptDebtShare(b, debtSnapshot) - conceptDebtShare(a, debtSnapshot))
      .slice(0, 5);

    const priorities = priorityConcepts.map((c) => {
      const { reason, action } = describeConceptPriority({
        groundedness: debtSnapshot.residualByConcept.get(c.id),
        sigma: conceptLiveStaleness(c, debtSnapshot),
        driftedCount: debtSnapshot.symbolDriftWarnings.get(c.id)?.length ?? 0,
        coverage: debtSnapshot.bindingCoverageByConcept.get(c.id),
      });
      const lastNarrative = getLastNarrativeForConcept(db, c.id);
      const chunkRow = c.active_chunk_id ? getChunk(db, c.active_chunk_id) : null;
      return {
        concept: c.name,
        action,
        reason,
        last_narrative: lastNarrative ?? undefined,
        changed_at: chunkRow?.created_at ?? undefined,
      };
    });

    // Build connectivity suggestions
    const suggestions: StatusResult["suggestions"] = [];
    if (concepts.length >= 2) {
      const fiedlerValue = manifest?.fiedler_value ?? 0;
      const edges = getEdges(db);

      // Group concepts by cluster
      const clusterMap = new Map<number, ConceptRow[]>();
      for (const c of concepts) {
        if (c.cluster != null) {
          const list = clusterMap.get(c.cluster);
          if (list) list.push(c);
          else clusterMap.set(c.cluster, [c]);
        }
      }

      // Build set of connected cluster pairs
      const conceptCluster = new Map<string, number>();
      for (const c of concepts) {
        if (c.cluster != null) conceptCluster.set(c.id, c.cluster);
      }
      const connectedPairs = new Set<string>();
      for (const edge of edges) {
        const ca = conceptCluster.get(edge.from_id);
        const cb = conceptCluster.get(edge.to_id);
        if (ca != null && cb != null && ca !== cb) {
          const key = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
          connectedPairs.add(key);
        }
      }

      // Find disconnected cluster pairs
      const clusterIds = [...clusterMap.keys()].sort((a, b) => a - b);
      for (let i = 0; i < clusterIds.length && suggestions.length < 3; i++) {
        for (let j = i + 1; j < clusterIds.length && suggestions.length < 3; j++) {
          const key = `${clusterIds[i]}:${clusterIds[j]}`;
          if (!connectedPairs.has(key)) {
            const a = clusterMap.get(clusterIds[i]!)![0]!;
            const b = clusterMap.get(clusterIds[j]!)![0]!;
            suggestions.push({
              action: "connect",
              concepts: [a.name, b.name],
              reason: "Isolated clusters — bridging entries will reduce debt",
            });
          }
        }
      }

      // Fragmentation warning
      if (fiedlerValue < config.thresholds.fiedler_drop && suggestions.length < 3) {
        suggestions.push({
          action: "bridge",
          concepts: [],
          reason: "Knowledge graph is fragmented — bridging entries will reduce debt",
        });
      }
    }

    // Embedding mismatch adds a maintenance priority and feeds ask-debt.
    //
    // The mind-level priorities below unshift, so they lead the concept work.
    // The compact status renders the first three, and a mind with concept
    // pressure is the one most likely to hide a broken lane behind them.
    if (staleEmbeddings > 0) {
      const staleModels = embeddingModels
        .filter((r) => !validModels.has(r.model))
        .map((r) => r.model);
      priorities.unshift({
        concept: "(embeddings)",
        action: "refresh embeddings",
        reason: `${staleEmbeddings} chunk embeddings use outdated model ${staleModels.join(", ")} (current: ${currentModel}). Run lore sys embeddings refresh.`,
        last_narrative: undefined,
        changed_at: undefined,
      });
    }

    // The symbol lane raises its own priority. `lore sys embeddings refresh`
    // repairs both lanes, but the reason must name the lane and its model, or
    // the operator cannot tell which count moved. The count holds the symbols
    // no reader can reach, so the consequence it names is true: a symbol that
    // also carries a current-model row stays out of it.
    if (staleSymbolEmbeddings > 0) {
      const staleSymbolModels = staleSymbolEmbeddingModels(db, currentCodeModel);
      priorities.unshift({
        concept: "(symbol embeddings)",
        action: "refresh embeddings",
        reason: currentCodeModel
          ? `${staleSymbolEmbeddings} of ${symbolLane.embedded} embedded symbols hold no vector on code model ${currentCodeModel} (they hold ${staleSymbolModels.join(", ")}). Symbol search and automatic binding skip them. Run lore sys embeddings refresh.`
          : `${staleSymbolEmbeddings} embedded symbols hold vectors on ${staleSymbolModels.join(", ")} and no code model is configured. Set ai.embedding.code.model, then run lore sys embeddings refresh.`,
        last_narrative: undefined,
        changed_at: undefined,
      });
    }

    // Orphans no longer enter the embedding counts above, so status must name
    // them here. A mind written before the delete paths cleared their
    // dependents keeps the rows until a prune removes them.
    if (orphanedRows > 0) {
      priorities.unshift({
        concept: "(database)",
        action: "prune database",
        reason: `${orphanedRows} row(s) belong to chunks or symbols that are gone. Run lore sys prune.`,
        last_narrative: undefined,
        changed_at: undefined,
      });
    }

    // The same disk a delete leaves behind, in the other store. Raised on the
    // same limits the automatic compaction uses, so the operator sees it only
    // when the store holds enough to pay for a compaction.
    if (
      lanceSpace.superseded_bytes >= RECLAIM_MIN_SUPERSEDED_BYTES &&
      lanceSpace.superseded_ratio >= RECLAIM_MIN_SUPERSEDED_RATIO
    ) {
      const percent = (lanceSpace.superseded_ratio * 100).toFixed(0);
      priorities.unshift({
        concept: "(search index)",
        action: "prune search index",
        reason: `${formatBytes(lanceSpace.superseded_bytes)} of the ${formatBytes(lanceSpace.on_disk_bytes)} search index is superseded versions no reader can reach (${percent}%). Run lore sys prune.`,
        last_narrative: undefined,
        changed_at: undefined,
      });
    }

    if (closeMaintenance.failed > 0 || closeMaintenance.queued + closeMaintenance.leased > 0) {
      priorities.unshift({
        concept: "(maintenance)",
        action: closeMaintenance.failed > 0 ? "repair queue" : "drain queue",
        reason:
          closeMaintenance.failed > 0
            ? `${closeMaintenance.failed} close maintenance job(s) failed`
            : `${closeMaintenance.queued + closeMaintenance.leased} close maintenance job(s) pending`,
        last_narrative: undefined,
        changed_at: closeMaintenance.oldest_pending_at ?? undefined,
      });
    }

    // Reported whenever the mind holds embedding rows at all. A mind whose rows
    // are every one of them orphaned reports zero live, which reads differently
    // from a mind that was never embedded.
    const embeddingStatus =
      totalEmbeddings > 0 || orphanedRows > 0
        ? {
            total: totalEmbeddings,
            current_model: matchingEmbeddings,
            stale: staleEmbeddings,
            model: currentModel,
          }
        : undefined;

    // Reported whenever the mind holds a symbol, not only when the lane holds a
    // vector. A lane the code pass emptied — it deletes first and swallows a
    // failed batch — reports 0 embedded of N symbols, which reads differently
    // from a mind that has no code indexed.
    const symbolEmbeddingStatus =
      symbolLane.symbols > 0 || symbolLane.embedded > 0
        ? {
            symbols: symbolLane.symbols,
            total: symbolLane.embedded,
            current_model: symbolLane.currentModel,
            stale: staleSymbolEmbeddings,
            model: currentCodeModel,
          }
        : undefined;

    const conceptHealth = this.persistConceptHealthRun(db, concepts, manifest, debtSnapshot, {
      top: 5,
    });

    // Lake stats: code + doc + journal chunks, staleness for both lanes
    let lake: StatusResult["lake"];
    try {
      const lastCodeIndexedAt = getLastScannedAt(db);
      const lastCodeMs = lastCodeIndexedAt ? new Date(lastCodeIndexedAt).getTime() : 0;
      const docLane = getDocLaneStats(db);
      const lastDocIndexedAt = docLane.last_indexed_at;
      const lastDocMs = lastDocIndexedAt ? new Date(lastDocIndexedAt).getTime() : 0;

      // Count stale source files (modified since last code scan)
      const sourceFiles = discoverFiles(entry.code_path);
      let staleSourceFiles = 0;
      for (const file of sourceFiles) {
        try {
          if (statSync(file.absolutePath).mtimeMs > lastCodeMs) staleSourceFiles++;
        } catch {
          // file disappeared — skip
        }
      }

      // Count stale doc files (modified since last doc ingest)
      const docFiles = discoverTextFiles(entry.code_path);
      let staleDocFiles = 0;
      for (const file of docFiles) {
        try {
          if (statSync(file.absolutePath).mtimeMs > lastDocMs) staleDocFiles++;
        } catch {
          // file disappeared — skip
        }
      }

      // The stale counts walk the disk, so the disk counts are their
      // denominators. A lake count would make the ratio pass 100% as soon as
      // the tree holds a file the last index run did not see.
      lake = {
        source_chunks: getSourceChunkCount(db),
        source_files: getSourceFileCount(db),
        doc_chunks: docLane.chunks,
        doc_files: docLane.files,
        journal_entries: getJournalEntryCount(db),
        last_code_indexed_at: lastCodeIndexedAt,
        last_doc_indexed_at: lastDocIndexedAt,
        discovered_source_files: sourceFiles.length,
        stale_source_files: staleSourceFiles,
        discovered_doc_files: docFiles.length,
        stale_doc_files: staleDocFiles,
      };
    } catch {
      // non-fatal: no code path or discovery failed
    }

    // Coverage stats (safe for pre-migration DBs)
    let coverage: StatusResult["coverage"];
    try {
      // Prune stale bindings (missing symbols/concepts) before computing stats
      pruneOrphanedBindings(db);
      const coverageStats = getCoverageStats(db);
      if (coverageStats.total_exported > 0) {
        const bindingCounts = getBindingCounts(db);
        const driftedBindings = getDriftedBindings(db);
        const avgConf = db
          .query<{ avg: number | null }, []>(`SELECT AVG(confidence) as avg FROM concept_symbols`)
          .get();
        const conceptsWithBindings = db
          .query<{ cnt: number }, []>(
            `SELECT COUNT(DISTINCT concept_id) as cnt FROM concept_symbols`,
          )
          .get();
        coverage = {
          exported_covered: coverageStats.bound_exported,
          exported_total: coverageStats.total_exported,
          ratio: coverageStats.bound_exported / coverageStats.total_exported,
          total_bindings: bindingCounts.total,
          by_type: { ref: bindingCounts.ref, mention: bindingCounts.mention },
          avg_confidence: avgConf?.avg ?? 0,
          drifted: driftedBindings.length,
          concepts_with_bindings: conceptsWithBindings?.cnt ?? 0,
          concepts_total: concepts.length,
        };
      }
    } catch {
      // symbols/concept_symbols tables may not exist yet
    }

    const askDebtSnapshot = computeAskDebtSnapshot({
      db,
      entry,
      config,
      concepts,
      debtSnapshot,
      coverage: coverage ? { ratio: coverage.ratio } : null,
      lake: lake
        ? {
            stale_source_files: lake.stale_source_files,
            discovered_source_files: lake.discovered_source_files,
            stale_doc_files: lake.stale_doc_files,
            discovered_doc_files: lake.discovered_doc_files,
          }
        : null,
      // Both lanes. The component is one figure for the embedding state, so a
      // stale symbol lane must move it; status would otherwise report a stale
      // lane beside embedding_mismatch 0.
      embeddingStatus:
        embeddingStatus || symbolEmbeddingStatus
          ? {
              total: (embeddingStatus?.total ?? 0) + (symbolEmbeddingStatus?.total ?? 0),
              stale: (embeddingStatus?.stale ?? 0) + (symbolEmbeddingStatus?.stale ?? 0),
            }
          : null,
    });

    // Health follows the config-owned band; an unmeasured mind is not "good".
    const health: StatusResult["health"] =
      askDebtSnapshot.band === "healthy"
        ? "good"
        : askDebtSnapshot.band === "critical"
          ? "critical"
          : "degrading";
    return {
      lore_name: name,
      health,
      summary:
        askDebtSnapshot.debt == null
          ? `${concepts.length} concepts, debt n/a`
          : `${concepts.length} concepts, debt ${(askDebtSnapshot.debt * 100).toFixed(0)}%`,
      debt: askDebtSnapshot.debt,
      debt_band: askDebtSnapshot.band,
      raw_debt: rawDebt,
      raw_debt_breakdown: askDebtSnapshot.raw_debt_breakdown,
      debt_breakdown: {
        persisted: askDebtSnapshot.raw_debt_breakdown.persisted,
        live: askDebtSnapshot.raw_debt_breakdown.live,
        display: askDebtSnapshot.raw_debt_breakdown.display,
      },
      debt_components: {
        symbol_drift: askDebtSnapshot.components.symbol_drift,
        code_freshness: askDebtSnapshot.components.code_freshness,
        doc_freshness: askDebtSnapshot.components.doc_freshness,
        coverage_gap: askDebtSnapshot.components.coverage_gap,
        embedding_mismatch: askDebtSnapshot.components.embedding_mismatch,
        active_narrative_hygiene: askDebtSnapshot.components.active_narrative_hygiene,
        write_activity_72h: {
          journal_entries: askDebtSnapshot.components.write_activity_72h.journal_entries,
          closed_narratives: askDebtSnapshot.components.write_activity_72h.closed_narratives,
        },
        narrative_hygiene_72h: {
          open_narratives: askDebtSnapshot.components.narrative_hygiene_72h.open_narratives,
          empty_open_narratives:
            askDebtSnapshot.components.narrative_hygiene_72h.empty_open_narratives,
          dangling_narratives: askDebtSnapshot.components.narrative_hygiene_72h.dangling_narratives,
        },
      },
      debt_previous: debtPrevious,
      debt_delta: debtChange,
      priorities,
      active_narratives: activeNarrativesList.map((d) => ({
        name: d.name,
        status: d.status,
        entry_count: d.entry_count,
        note:
          d.status === "closing"
            ? "Closing in background"
            : d.status === "close_failed"
              ? "Close failed; write or retry close"
              : d.entry_count < 3
                ? "Early stage"
                : "In progress",
      })),
      dangling_narratives: danglingNarratives.map((d) => ({
        name: d.name,
        age_days: Math.floor(
          (Date.now() - new Date(d.opened_at).getTime()) / (24 * 60 * 60 * 1000),
        ),
        action: "close or abandon",
      })),
      embedding_status: embeddingStatus,
      symbol_embedding_status: symbolEmbeddingStatus,
      maintenance: this.computeMaintenance(
        db,
        entry.lore_path,
        concepts.length,
        closeJobs,
        closeMaintenance,
      ),
      suggestions,
      concept_health: {
        run_id: conceptHealth.run_id,
        computed_at: conceptHealth.computed_at,
        top_stale: conceptHealth.top_stale,
      },
      coverage,
      // Reported whenever the store exists, so an operator can watch the waste
      // grow instead of meeting it as a full disk.
      search_index:
        lanceSpace.on_disk_bytes > 0
          ? {
              on_disk_bytes: lanceSpace.on_disk_bytes,
              live_bytes: lanceSpace.live_bytes,
              superseded_bytes: lanceSpace.superseded_bytes,
            }
          : undefined,
      lake,
      state_distance: askDebtSnapshot.state_distance,
    };
  }

  healthSnapshot(opts?: { codePath?: string }): LoreHealthSnapshot {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const manifest = getManifest(db);
    const debt = manifest?.debt ?? 0;
    const health: LoreHealthSnapshot["health"] =
      debt >= 25 ? "critical" : debt >= 10 ? "degrading" : "good";
    return {
      health,
      debt,
      debt_trend: (manifest?.debt_trend as DebtTrend) ?? "stable",
      concept_count: manifest?.concept_count ?? 0,
    };
  }

  private persistConceptHealthRun(
    db: Database,
    concepts: ConceptRow[],
    manifest: ReturnType<typeof getManifest>,
    debtSnapshot: DebtSnapshot,
    opts?: { top?: number },
  ): ConceptHealthComputeResult {
    const runId = ulid();
    const computedAt = new Date().toISOString();
    const relations = getConceptRelations(db, { includeInactive: false });
    const tags = getConceptTags(db);
    const criticalConceptIds = new Set(
      tags
        .filter((tag) => tag.tag === "critical" || tag.tag === "anchor" || tag.tag === "core")
        .map((tag) => tag.concept_id),
    );

    const computed = computeConceptHealthSignals({
      concepts,
      refDriftScoreByConcept: debtSnapshot.refDriftScoreByConcept,
      sigmaByConcept: debtSnapshot.sigmaByConcept,
      residualByConcept: debtSnapshot.residualByConcept,
      relations,
      criticalConceptIds,
      fiedlerValue: manifest?.fiedler_value ?? 0,
      baseDebt: debtSnapshot.debt,
    });

    for (const signal of computed.signals) {
      insertConceptHealthSignal(
        db,
        {
          run_id: runId,
          concept_id: signal.concept_id,
          time_stale: signal.time_stale,
          ref_stale: signal.ref_stale,
          local_graph_stale: signal.local_graph_stale,
          global_shock: signal.global_shock,
          influence: signal.influence,
          critical_multiplier: signal.critical_multiplier,
          final_stale: signal.final_stale,
          residual_after_adjust: signal.residual_after_adjust,
          debt_after_adjust: signal.debt_after_adjust,
        },
        computedAt,
      );
    }

    const top = Math.max(1, opts?.top ?? 5);
    const topStale = computed.signals.slice(0, top).map((signal) => ({
      concept: signal.concept,
      final_stale: signal.final_stale,
      time_stale: signal.time_stale,
      ref_stale: signal.ref_stale,
      local_graph_stale: signal.local_graph_stale,
      global_shock: signal.global_shock,
      influence: signal.influence,
      critical: signal.critical_multiplier > 1,
    }));

    return {
      run_id: runId,
      computed_at: computedAt,
      concepts_scanned: concepts.length,
      debt: computed.debtAfterAdjust,
      debt_trend: computeDebtTrend(computed.debtAfterAdjust, debtSnapshot.persisted_debt),
      top_stale: topStale,
    };
  }

  private computeMaintenance(
    db: Database,
    lorePath: string,
    conceptCount: number,
    closeJobs = getCloseJobCounts(db, { lorePath }),
    closeMaintenance = getCloseMaintenanceJobCounts(db, { lorePath }),
  ): StatusResult["maintenance"] {
    const pendingWork =
      closeJobs.queued + closeJobs.leased + closeMaintenance.queued + closeMaintenance.leased;
    const failedWork = closeJobs.failed + closeMaintenance.failed;
    const oldestPendingAt =
      [closeJobs.oldest_pending_at, closeMaintenance.oldest_pending_at]
        .filter((value): value is string => value != null)
        .sort()[0] ?? null;
    if (conceptCount === 0) {
      return {
        status:
          failedWork > 0
            ? "close-maintenance-failed"
            : pendingWork > 0
              ? "close-maintenance-pending"
              : "n/a",
        min_delta_rate: 0,
        current_rate: 0,
        pending_close_jobs: pendingWork,
        failed_close_jobs: failedWork,
        oldest_close_job_at: oldestPendingAt,
      };
    }

    const WINDOW_DAYS = 14;
    const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

    // Count narratives closed (merged, not abandoned) within the window
    const allNarratives = getAllNarratives(db);
    const recentClosed = allNarratives.filter(
      (d) => d.status === "closed" && d.closed_at && d.closed_at >= cutoff,
    );
    const currentRate = (recentClosed.length / WINDOW_DAYS) * 7; // per week

    // Floor: ~1 narrative per 10 concepts per week, minimum 1
    const minNarrativeRate = Math.max(1, Math.ceil(conceptCount / 10));

    let status = currentRate >= minNarrativeRate ? "above-floor" : "below-floor";
    if (failedWork > 0) {
      status = "close-maintenance-failed";
    } else if (pendingWork > 0) {
      status = "close-maintenance-pending";
    }
    return {
      status,
      min_delta_rate: Math.round(minNarrativeRate * 10) / 10,
      current_rate: Math.round(currentRate * 10) / 10,
      pending_close_jobs: pendingWork,
      failed_close_jobs: failedWork,
      oldest_close_job_at: oldestPendingAt,
    };
  }

  private metricDelta(current: number | null | undefined, previous: number | null | undefined) {
    if (current == null || previous == null) return null;
    return current - previous;
  }

  private ensureGraphFresh(db: Database, lorePath: string): void {
    const manifest = getManifest(db);
    if (
      manifest?.graph_stale &&
      !hasPendingCloseMaintenanceJobs(db, { lorePath }) &&
      !hasPendingCloseJobs(db, { lorePath })
    ) {
      recomputeGraph(db);
    }
  }

  async conceptRename(
    from: string,
    to: string,
    opts?: { codePath?: string },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return renameConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), from, to);
  }

  async conceptArchive(
    name: string,
    opts?: { codePath?: string; reason?: string },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return archiveConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), name, opts?.reason);
  }

  async conceptRestore(name: string, opts?: { codePath?: string }): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return restoreConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), name);
  }

  async conceptMerge(
    sourceName: string,
    targetName: string,
    opts?: { codePath?: string; reason?: string; preview?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return mergeConcept(
      this.lifecycleDeps(entry, db, this.configFor(entry)),
      sourceName,
      targetName,
      {
        reason: opts?.reason,
        preview: opts?.preview,
      },
    );
  }

  async conceptSplit(
    name: string,
    opts?: { codePath?: string; parts?: number; preview?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return splitConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), name, {
      parts: opts?.parts,
      preview: opts?.preview,
    });
  }

  async conceptPatch(
    name: string,
    text: string,
    opts?: { codePath?: string; topics?: string[]; direct?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return patchConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), name, text, {
      topics: opts?.topics,
      direct: opts?.direct,
    });
  }

  async conceptRebuild(name: string, opts?: { codePath?: string }): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    return rebuildConcept(this.lifecycleDeps(entry, db, this.configFor(entry)), name);
  }

  setConceptRelation(
    fromConceptName: string,
    toConceptName: string,
    relationType: RelationType,
    opts?: { codePath?: string; weight?: number },
  ): ConceptRelationSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const from = resolveConceptByNameCi(db, fromConceptName, { activeOnly: true });
    const to = resolveConceptByNameCi(db, toConceptName, { activeOnly: true });
    if (from.id === to.id) {
      throw new LoreError("CONCEPT_INVALID_STATE", "Relation source and target must be different");
    }

    const relation = upsertConceptRelation(db, from.id, to.id, relationType, opts?.weight ?? 1);
    markGraphStale(db);
    return {
      from_concept: from.name,
      to_concept: to.name,
      relation_type: relation.relation_type,
      weight: relation.weight,
      active: relation.active === 1,
      updated_at: relation.updated_at,
    };
  }

  unsetConceptRelation(
    fromConceptName: string,
    toConceptName: string,
    opts?: { codePath?: string; relationType?: RelationType },
  ): { removed: number } {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const from = resolveConceptByNameCi(db, fromConceptName, { activeOnly: true });
    const to = resolveConceptByNameCi(db, toConceptName, { activeOnly: true });
    const removed = deactivateConceptRelation(db, from.id, to.id, opts?.relationType);
    if (removed > 0) markGraphStale(db);
    return { removed };
  }

  listConceptRelations(opts?: {
    codePath?: string;
    concept?: string;
    includeInactive?: boolean;
  }): ConceptRelationSummary[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptId = opts?.concept
      ? resolveConceptByNameCi(db, opts.concept, { activeOnly: false }).id
      : undefined;
    const relations = getConceptRelations(db, {
      conceptId,
      includeInactive: opts?.includeInactive,
    });
    const conceptById = new Map(getConcepts(db).map((concept) => [concept.id, concept.name]));

    const rows: ConceptRelationSummary[] = [];
    for (const relation of relations) {
      const from = conceptById.get(relation.from_concept_id);
      const to = conceptById.get(relation.to_concept_id);
      if (!from || !to) continue;
      rows.push({
        from_concept: from,
        to_concept: to,
        relation_type: relation.relation_type,
        weight: relation.weight,
        active: relation.active === 1,
        updated_at: relation.updated_at,
      });
    }

    return rows;
  }

  tagConcept(conceptName: string, tag: string, opts?: { codePath?: string }): ConceptTagSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = resolveConceptByNameCi(db, conceptName, { activeOnly: true });
    const row = upsertConceptTag(db, concept.id, tag);
    return {
      concept: concept.name,
      tag: row.tag,
      created_at: row.created_at,
    };
  }

  untagConcept(
    conceptName: string,
    tag: string,
    opts?: { codePath?: string },
  ): { concept: string; tag: string; removed: number } {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = resolveConceptByNameCi(db, conceptName, { activeOnly: false });
    const removed = removeConceptTag(db, concept.id, tag);
    return {
      concept: concept.name,
      tag: tag.trim().toLowerCase(),
      removed,
    };
  }

  listConceptTags(opts?: { codePath?: string; concept?: string }): ConceptTagSummary[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptId = opts?.concept
      ? resolveConceptByNameCi(db, opts.concept, { activeOnly: false }).id
      : undefined;
    const tags = getConceptTags(db, conceptId);
    const conceptById = new Map(getConcepts(db).map((concept) => [concept.id, concept.name]));

    const rows: ConceptTagSummary[] = [];
    for (const tag of tags) {
      const concept = conceptById.get(tag.concept_id);
      if (!concept) continue;
      rows.push({
        concept,
        tag: tag.tag,
        created_at: tag.created_at,
      });
    }

    return rows;
  }

  // ─── KPIs ───────────────────────────────────────────────

  private kpiReadingSummary(db: Database, row: KpiReadingRow): KpiReadingSummary {
    let meta: Record<string, unknown> | null = null;
    if (row.meta_json) {
      try {
        meta = JSON.parse(row.meta_json) as Record<string, unknown>;
      } catch {
        meta = null;
      }
    }
    const narrative = row.narrative_id ? (getNarrative(db, row.narrative_id)?.name ?? null) : null;
    return {
      id: row.id,
      value: row.value,
      narrative,
      git_head: row.git_head,
      lore_commit_id: row.lore_commit_id,
      meta,
      created_at: row.created_at,
    };
  }

  private kpiStatusFor(db: Database, kpi: KpiRow, recentLimit: number): KpiStatus {
    const goal = getCurrentKpiGoal(db, kpi.name);
    const recentRows = listKpiReadings(db, kpi.name, Math.max(recentLimit, 2));
    const recent = recentRows.slice(0, recentLimit).map((row) => this.kpiReadingSummary(db, row));
    const latest = recent[0] ?? null;
    const previousRow = recentRows[1];
    const previous = previousRow ? this.kpiReadingSummary(db, previousRow) : null;
    const sign = kpi.direction === "up" ? 1 : -1;
    const count =
      db
        .query<{ n: number }, [string]>("SELECT COUNT(*) AS n FROM kpi_readings WHERE kpi_name = ?")
        .get(kpi.name)?.n ?? 0;

    let gap: number | null = null;
    let goalMet: boolean | null = null;
    if (goal && latest) {
      const remaining = sign * (goal.target - latest.value);
      gap = Math.max(0, remaining);
      goalMet = remaining <= 0;
    }

    return {
      name: kpi.name,
      unit: kpi.unit,
      direction: kpi.direction,
      note: kpi.note,
      goal: goal?.target ?? null,
      goal_set_at: goal?.set_at ?? null,
      latest,
      previous,
      delta_toward_goal: latest && previous ? sign * (latest.value - previous.value) : null,
      gap,
      goal_met: goalMet,
      reading_count: count,
      recent,
    };
  }

  /** Resolve or create the KPI row. Creation needs a direction so "toward the
   *  goal" is well-defined from the first reading. */
  private ensureKpi(
    db: Database,
    name: string,
    opts: { direction?: KpiDirection; unit?: string | null; note?: string | null },
  ): { kpi: KpiRow; created: boolean } {
    const existing = getKpi(db, name);
    if (existing) return { kpi: existing, created: false };
    if (!opts.direction) {
      throw new LoreError(
        "KPI_NOT_FOUND",
        `KPI '${name}' does not exist yet. Pass --direction up|down to create it (which way is better?).`,
      );
    }
    return {
      kpi: insertKpi(db, { name, direction: opts.direction, unit: opts.unit, note: opts.note }),
      created: true,
    };
  }

  /** Narrative a reading belongs to: the named one, else the sole open one, else none. */
  private resolveKpiNarrativeId(db: Database, narrativeName?: string): string | null {
    if (narrativeName) {
      const narrative = getNarrativeByName(db, narrativeName);
      if (!narrative) {
        throw new LoreError("LORE_NOT_FOUND", `Narrative '${narrativeName}' not found`);
      }
      return narrative.id;
    }
    const open = getOpenNarratives(db);
    return open.length === 1 ? (open[0]?.id ?? null) : null;
  }

  /**
   * Record something that ran.
   *
   * A KPI reading is one scalar over time. A run is the event behind it: what
   * it was given, every number it produced, and the files it left. Provenance
   * matches a reading exactly, so a run and a KPI logged from it agree on
   * which narrative, git head and lore commit produced them.
   */
  async runLog(name: string, opts?: RunLogOptions): Promise<RunSummary> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const gitHead = await getHeadSha(entry.code_path);
    const narrativeId = this.resolveKpiNarrativeId(db, opts?.narrative);

    const row = insertRun(db, {
      name,
      // A run nobody graded is a success by default: the common case is
      // recording something that worked, and demanding the flag every time is
      // the friction that stops it being recorded at all.
      outcome: opts?.outcome ?? "success",
      params: opts?.params,
      metrics: opts?.metrics,
      artifacts: opts?.artifacts,
      note: opts?.note,
      narrativeId,
      gitHead,
      loreCommitId: getHeadCommit(db)?.id ?? null,
    });
    return this.runSummary(db, row);
  }

  runList(opts?: RunListOptions): RunSummary[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return listRuns(db, { name: opts?.name, since: opts?.since, limit: opts?.limit }).map((row) =>
      this.runSummary(db, row),
    );
  }

  runShow(id: string, opts?: { codePath?: string }): RunSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const row = getRun(db, id);
    if (!row) throw new LoreError("LORE_NOT_FOUND", `Run '${id}' not found`);
    return this.runSummary(db, row);
  }

  /** Read the JSON columns back and name the narrative, which is what a
   *  reader wants and an id is not. */
  private runSummary(db: Database, row: RunRow): RunSummary {
    const parse = <T>(raw: string | null, fallback: T): T => {
      if (!raw) return fallback;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // A row written by a future version must not break a listing.
        return fallback;
      }
    };
    return {
      id: row.id,
      name: row.name,
      outcome: row.outcome,
      params: parse<Record<string, string>>(row.params_json, {}),
      metrics: parse<Record<string, number>>(row.metrics_json, {}),
      artifacts: parse<string[]>(row.artifacts_json, []),
      note: row.note,
      narrative: row.narrative_id ? (getNarrative(db, row.narrative_id)?.name ?? null) : null,
      git_head: row.git_head,
      lore_commit_id: row.lore_commit_id,
      created_at: row.created_at,
    };
  }

  async kpiLog(
    name: string,
    value: number,
    opts?: {
      codePath?: string;
      direction?: KpiDirection;
      unit?: string | null;
      note?: string | null;
      narrative?: string;
      meta?: Record<string, unknown> | null;
    },
  ): Promise<KpiLogResult> {
    if (!Number.isFinite(value)) {
      throw new LoreError("KPI_INVALID_VALUE", `KPI value must be a finite number, got '${value}'`);
    }
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const gitHead = await getHeadSha(entry.code_path);
    const narrativeId = this.resolveKpiNarrativeId(db, opts?.narrative);

    const { kpi, created, reading } = db.transaction(() => {
      const ensured = this.ensureKpi(db, name, opts ?? {});
      const row = insertKpiReading(db, {
        kpiName: ensured.kpi.name,
        value,
        narrativeId,
        gitHead,
        loreCommitId: getHeadCommit(db)?.id ?? null,
        meta: opts?.meta,
      });
      return { kpi: ensured.kpi, created: ensured.created, reading: row };
    })();

    return {
      kpi: this.kpiStatusFor(db, kpi, 10),
      reading: this.kpiReadingSummary(db, reading),
      created_kpi: created,
    };
  }

  kpiGoal(
    name: string,
    target: number,
    opts?: {
      codePath?: string;
      direction?: KpiDirection;
      unit?: string | null;
      note?: string | null;
    },
  ): KpiGoalResult {
    if (!Number.isFinite(target)) {
      throw new LoreError("KPI_INVALID_VALUE", `KPI goal must be a finite number, got '${target}'`);
    }
    const { db } = this.resolveLoreMind(opts?.codePath);
    const { kpi, created } = db.transaction(() => {
      const ensured = this.ensureKpi(db, name, opts ?? {});
      insertKpiGoal(db, { kpiName: ensured.kpi.name, target });
      return ensured;
    })();
    return { kpi: this.kpiStatusFor(db, kpi, 10), created_kpi: created };
  }

  kpiStatus(opts?: { codePath?: string; name?: string; limit?: number }): KpiStatus[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const limit = opts?.limit ?? 10;
    if (opts?.name) {
      const kpi = getKpi(db, opts.name);
      if (!kpi) throw new LoreError("KPI_NOT_FOUND", `KPI '${opts.name}' not found`);
      return [this.kpiStatusFor(db, kpi, limit)];
    }
    return listKpis(db).map((kpi) => this.kpiStatusFor(db, kpi, limit));
  }

  async computeConceptHealth(opts?: {
    codePath?: string;
    top?: number;
  }): Promise<ConceptHealthComputeResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const concepts = getActiveConcepts(db);
    const manifest = getManifest(db);
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest, {
      stalenessDays: config.thresholds.staleness_days,
    });
    return this.persistConceptHealthRun(db, concepts, manifest, debtSnapshot, { top: opts?.top });
  }

  async explainConceptHealth(
    conceptName: string,
    opts?: { codePath?: string; neighborLimit?: number; recompute?: boolean },
  ): Promise<ConceptHealthExplainResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = resolveConceptByNameCi(db, conceptName, { activeOnly: true });
    if (opts?.recompute || !getCurrentConceptHealthSignal(db, concept.id)) {
      await this.computeConceptHealth({ codePath: opts?.codePath });
    }

    const explain = getConceptHealthExplainRow(db, concept.id);
    if (!explain) {
      throw new LoreError(
        "CONCEPT_INVALID_STATE",
        `Concept health is unavailable for '${concept.name}'.`,
      );
    }

    const relations = getConceptRelations(db, { conceptId: concept.id, includeInactive: false });
    const conceptsById = new Map(getActiveConcepts(db).map((item) => [item.id, item]));
    const finalStaleByConceptId = new Map(
      getCurrentConceptHealthSignals(db).map((signal) => [signal.concept_id, signal.final_stale]),
    );
    const neighborLimit = Math.max(1, opts?.neighborLimit ?? 8);

    return {
      ...explain,
      neighbors: buildConceptHealthNeighbors(
        concept.id,
        relations,
        conceptsById,
        finalStaleByConceptId,
      ).slice(0, neighborLimit),
    };
  }

  async healConcepts(opts?: {
    codePath?: string;
    threshold?: number;
    limit?: number;
    dry?: boolean;
    workers?: number;
    batchSize?: number;
    leaseTtlMs?: number;
    maxRetries?: number;
    runId?: string;
  }): Promise<HealConceptsResult> {
    const { name, entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const dry = opts?.dry ?? false;
    const threshold = Math.max(0, Math.min(1, opts?.threshold ?? 0.6));
    const limit = Math.max(1, opts?.limit ?? 5);
    const workers = Math.max(1, Math.floor(opts?.workers ?? 4));
    const batchSize = Math.max(1, Math.floor(opts?.batchSize ?? 5));
    const leaseTtlMs =
      opts?.leaseTtlMs !== undefined && Number.isFinite(opts.leaseTtlMs)
        ? Math.max(1_000, Math.floor(opts.leaseTtlMs))
        : 30_000;
    const maxRetries =
      opts?.maxRetries !== undefined && Number.isFinite(opts.maxRetries)
        ? Math.max(0, Math.floor(opts.maxRetries))
        : 0;
    const runId = opts?.runId?.trim() ? opts.runId.trim() : `heal-${ulid()}`;
    const stalenessDays = config.thresholds.staleness_days;

    // Candidates: concepts whose R(c) is worth acting on, ordered by how much
    // debt their healing would move — p(c)·R(c). Heal then goes and LOOKS
    // (engine/heal.ts); it never writes a concept healthier by formula.
    const concepts = getActiveConcepts(db);
    const snapshot = await computeDebtSnapshot(entry, db, concepts, getManifest(db), {
      stalenessDays,
    });
    const candidates = concepts
      .filter((concept) => conceptPressure(concept, snapshot) >= threshold)
      .sort((a, b) => conceptDebtShare(b, snapshot) - conceptDebtShare(a, snapshot))
      .slice(0, limit);

    const healed: HealConceptsResult["healed"] = [];
    const preDebt = snapshot.debt;
    let postDebt = preDebt;
    let retried = 0;
    let batchesProcessed = 0;

    if (candidates.length === 0) {
      return {
        run_id: runId,
        dry,
        considered: 0,
        healed: [],
        worker_stats: { configured: workers, completed: 0, failed: 0, retried: 0 },
        batch_stats: {
          processed: 0,
          halted_at_batch: null,
          pre_debt: preDebt,
          post_debt: postDebt,
        },
      };
    }

    if (dry) {
      for (const concept of candidates) {
        const plan = planHealConcept(db, concept, stalenessDays);
        healed.push({
          concept: plan.concept,
          from_residual: plan.from_residual,
          to_residual: plan.from_residual,
          from_staleness: plan.from_staleness,
          to_staleness: plan.from_staleness,
          ungrounded_before: plan.ungrounded_before,
          ungrounded_after: plan.ungrounded_before,
          bindings_added: 0,
          bindings_verified: 0,
          bindings_still_drifted: plan.bindings_still_drifted,
          e_embed: null,
          still_drifted_reasons: [],
          plan: [
            ...(plan.ungrounded_before ? ["extract bindings (ungrounded)"] : []),
            ...(plan.bindings_still_drifted > 0
              ? [`verify ${plan.bindings_still_drifted} drifted binding(s) against current code`]
              : []),
            plan.e_embed_measured ? "re-measure e_embed" : "measure e_embed (never measured)",
          ],
        });
      }
    } else {
      const deps: HealConceptDeps = {
        db,
        config,
        codePath: entry.code_path ?? null,
        embedder: await this.embedderFor(config, entry),
        codeEmbedder: await this.codeEmbedderFor(config, entry),
        generator: await this.generatorFor(config, entry),
      };

      queueConceptHealLeases(db, {
        lorePath: entry.lore_path,
        runId,
        conceptIds: candidates.map((concept) => concept.id),
      });
      type ClaimedLease = NonNullable<ReturnType<typeof claimConceptHealLease>>;

      const processLease = async (lease: ClaimedLease): Promise<void> => {
        const owner = lease.owner ?? "worker";
        try {
          const outcome = await healConcept(deps, lease.concept_id);
          if (!outcome) {
            skipConceptHealLease(db, {
              lorePath: entry.lore_path,
              runId,
              conceptId: lease.concept_id,
              owner,
              reason: "concept is no longer active",
            });
            return;
          }
          completeConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
          });
          healed.push({ ...outcome, plan: [] });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const fail = failConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
            error: message,
            retry: true,
            maxRetries,
          });
          if (fail.requeued) retried += 1;
        }
      };

      while (true) {
        const leasedBatch: ClaimedLease[] = [];
        for (let i = 0; i < batchSize; i++) {
          const owner = `worker-${(i % workers) + 1}`;
          const lease = claimConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            owner,
            leaseTtlMs,
            maxRetries,
          });
          if (!lease) break;
          leasedBatch.push(lease);
        }
        if (leasedBatch.length === 0) break;
        batchesProcessed += 1;

        let cursor = 0;
        const laneCount = Math.min(workers, leasedBatch.length);
        const lanes = Array.from({ length: laneCount }, async () => {
          while (true) {
            const next = leasedBatch[cursor];
            cursor += 1;
            if (!next) return;
            await processLease(next);
          }
        });
        await Promise.all(lanes);
      }

      // No stop-loss: heal measures, and a measurement that raises debt has
      // found debt that was already there. Halting on it would be the silent-
      // evidence failure the spec forbids.
      postDebt = computeExpectedDebt(db, getActiveConcepts(db)).debt ?? 0;
      upsertManifest(db, {
        debt: postDebt,
        debt_trend: computeDebtTrend(postDebt, preDebt),
      });
      await this.computeConceptHealth({ codePath: opts?.codePath });
    }

    const leaseCounts = dry
      ? null
      : getConceptHealLeaseStatusCounts(db, { lorePath: entry.lore_path, runId });

    return {
      run_id: runId,
      dry,
      considered: candidates.length,
      healed,
      worker_stats: {
        configured: workers,
        completed: dry ? healed.length : (leaseCounts?.done ?? 0),
        failed: dry ? 0 : (leaseCounts?.failed ?? 0),
        retried,
      },
      batch_stats: {
        processed: dry ? Math.ceil(candidates.length / batchSize) : batchesProcessed,
        halted_at_batch: null,
        pre_debt: preDebt,
        post_debt: postDebt,
      },
    };
  }

  // ─── CLI-Only Operations ──────────────────────────────

  async ls(opts?: { codePath?: string }) {
    const { name, entry, db } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db, entry.lore_path);
    const config = this.configFor(entry);
    const concepts = getActiveConcepts(db);
    const manifest = getManifest(db);
    const openNarratives = getActiveNarratives(db);
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest, {
      stalenessDays: config.thresholds.staleness_days,
    });
    // Present the axes, not the frozen columns: staleness is σ(c), residual is R(c).
    const conceptsWithLiveStaleness = concepts.map((concept) => ({
      ...concept,
      staleness: conceptLiveStaleness(concept, debtSnapshot),
      residual: conceptPressure(concept, debtSnapshot),
    }));
    const conceptTrends = conceptsWithLiveStaleness.map((concept) => {
      const previous = getPreviousConceptMetrics(db, concept.id);
      return {
        concept_id: concept.id,
        residual_delta: this.metricDelta(concept.residual, previous?.residual ?? null),
        staleness_delta: this.metricDelta(concept.staleness, previous?.staleness ?? null),
        previous_residual: previous?.residual ?? null,
        previous_staleness: previous?.staleness ?? null,
      };
    });
    const sortedConcepts = [...conceptsWithLiveStaleness].sort((a, b) => {
      const residualDiff = (b.residual ?? 0) - (a.residual ?? 0);
      if (Math.abs(residualDiff) > 1e-9) return residualDiff;
      const stalenessDiff = (b.staleness ?? 0) - (a.staleness ?? 0);
      if (Math.abs(stalenessDiff) > 1e-9) return stalenessDiff;
      return a.name.localeCompare(b.name);
    });
    const askDebtSnapshot = computeAskDebtSnapshot({
      db,
      entry,
      config,
      concepts: conceptsWithLiveStaleness,
      debtSnapshot,
    });
    const debtPrevious = null;
    const debtChange = null;

    const symbolCountRows = db
      .query<{ concept_id: string; count: number }, []>(
        `SELECT concept_id, COUNT(*) as count FROM concept_symbols GROUP BY concept_id`,
      )
      .all();
    const concept_symbol_counts: Record<string, number> = {};
    for (const row of symbolCountRows) {
      concept_symbol_counts[row.concept_id] = row.count;
    }

    return {
      lore_mind: { name, ...entry },
      concepts: sortedConcepts,
      concept_trends: conceptTrends,
      manifest,
      openNarratives,
      debt: askDebtSnapshot.debt,
      debt_previous: debtPrevious,
      debt_delta: debtChange,
      debt_trend: askDebtSnapshot.band,
      concept_symbol_counts,
    };
  }

  async show(
    conceptName: string,
    opts?: { codePath?: string; ref?: string; fromResultId?: string },
  ) {
    const { db } = this.resolveLoreMind(opts?.codePath);

    // Historical ref: resolve commit and look up concept in that tree
    if (opts?.ref) {
      const result = await this.showAtCommit(db, opts.ref, conceptName);
      this.recordInteraction(db, "show", {
        resultId: opts.fromResultId,
        subject: conceptName,
        meta: { ref: opts.ref },
      });
      return result;
    }

    const concept = getActiveConceptByName(db, conceptName);
    if (!concept) {
      throw new LoreError("CONCEPT_NOT_FOUND", `Concept '${conceptName}' not found`);
    }
    let chunkId = concept.active_chunk_id;
    if (!chunkId) {
      const latestChunk = db
        .query<{ id: string }, [string]>(
          `SELECT id FROM chunks
           WHERE concept_id = ? AND fl_type = 'chunk'
           ORDER BY created_at DESC LIMIT 1`,
        )
        .get(concept.id);
      chunkId = latestChunk?.id ?? null;
    }
    if (!chunkId) {
      this.recordInteraction(db, "show", {
        resultId: opts?.fromResultId,
        subject: conceptName,
        meta: { ref: null },
      });
      return { concept, content: null };
    }
    const chunkRow = getChunk(db, chunkId);
    if (!chunkRow) {
      this.recordInteraction(db, "show", {
        resultId: opts?.fromResultId,
        subject: conceptName,
        meta: { ref: null },
      });
      return { concept, content: null };
    }
    const parsed = await readChunk(chunkRow.file_path);
    this.recordInteraction(db, "show", {
      resultId: opts?.fromResultId,
      subject: conceptName,
      meta: { ref: null },
    });
    return { concept, content: parsed.content };
  }

  async showNarrativeTrail(
    narrativeName: string,
    opts?: { codePath?: string; fromResultId?: string },
  ): Promise<NarrativeTrailResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const narrative = getNarrativeByName(db, narrativeName);
    if (!narrative) {
      throw new LoreError("LORE_NOT_FOUND", `Narrative '${narrativeName}' not found`);
    }
    const journalChunks = getJournalChunksForNarrative(db, narrative.id);
    const entries: NarrativeTrailEntry[] = [];
    for (let i = 0; i < journalChunks.length; i++) {
      const chunk = journalChunks[i]!;
      const parsed = await readChunk(chunk.file_path);
      entries.push({
        content: parsed.content,
        topics: chunk.topics ? JSON.parse(chunk.topics) : [],
        status: chunk.status,
        created_at: chunk.created_at,
        position: i + 1,
      });
    }
    const topicSet = new Set(entries.flatMap((e) => e.topics));
    const result = {
      narrative: {
        name: narrative.name,
        intent: narrative.intent,
        status: narrative.status,
        entry_count: narrative.entry_count,
        opened_at: narrative.opened_at,
        closed_at: narrative.closed_at,
      },
      entries,
      topics_covered: [...topicSet],
    };
    this.recordInteraction(db, "trail", {
      resultId: opts?.fromResultId,
      subject: narrativeName,
      meta: { entry_count: entries.length },
    });
    return result;
  }

  async history(conceptName: string, opts?: { codePath?: string }) {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = getActiveConceptByName(db, conceptName);
    if (!concept) {
      throw new LoreError("CONCEPT_NOT_FOUND", `Concept '${conceptName}' not found`);
    }
    const chunks = getChunksForConcept(db, concept.id);

    // Build a map of chunk_id → commit info
    const commitMap = new Map<string, { id: string; message: string; committed_at: string }>();
    const commitRows = db
      .query<
        { chunk_id: string; commit_id: string; message: string; committed_at: string },
        [string]
      >(
        `SELECT ct.chunk_id, c.id as commit_id, c.message, c.committed_at FROM commits c
         JOIN commit_tree ct ON ct.commit_id = c.id
         WHERE ct.concept_id = ?
         ORDER BY c.id DESC`,
      )
      .all(concept.id);
    for (const row of commitRows) {
      if (!commitMap.has(row.chunk_id)) {
        commitMap.set(row.chunk_id, {
          id: row.commit_id,
          message: row.message,
          committed_at: row.committed_at,
        });
      }
    }

    // Build version chain: oldest first (v1, v2, ...)
    // chunks are ordered by created_at already
    const history: Array<{
      id: string;
      version: number;
      createdAt: string;
      supersedes: string | null;
      supersededBy: string | null;
      content: string;
      narrative?: { name: string; intent: string; entryCount: number };
      drift?: number;
      journalSnippets?: string[];
      commit?: { id: string; message: string };
    }> = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const parsed = await readChunk(chunk.file_path);
      const supersededBy = chunks.find((c) => c.supersedes_id === chunk.id);

      // Narrative info
      let narrative: { name: string; intent: string; entryCount: number } | undefined;
      if (chunk.narrative_id) {
        const narrativeRow = getNarrative(db, chunk.narrative_id);
        if (narrativeRow) {
          narrative = {
            name: narrativeRow.name,
            intent: narrativeRow.intent,
            entryCount: narrativeRow.entry_count,
          };
        }
      }

      // Drift: cosine distance between this chunk and its predecessor
      let drift: number | undefined;
      if (chunk.supersedes_id) {
        const curEmb = getEmbeddingForChunk(db, chunk.id);
        const prevEmb = getEmbeddingForChunk(db, chunk.supersedes_id);
        if (curEmb && prevEmb) {
          const a = new Float32Array(
            curEmb.embedding.buffer,
            curEmb.embedding.byteOffset,
            curEmb.embedding.byteLength / 4,
          );
          const b = new Float32Array(
            prevEmb.embedding.buffer,
            prevEmb.embedding.byteOffset,
            prevEmb.embedding.byteLength / 4,
          );
          drift = cosineDistance(a, b);
        }
      }

      // Journal snippets from the narrative, filtered to entries whose topics mention this concept
      let journalSnippets: string[] | undefined;
      if (chunk.narrative_id) {
        const journalChunks = getJournalChunksForNarrative(db, chunk.narrative_id);
        const relevant = journalChunks.filter((j) => {
          if (!j.topics) return false;
          const topics = typeof j.topics === "string" ? j.topics.split(",") : [];
          return topics.some((t) => t.trim().toLowerCase() === conceptName.toLowerCase());
        });
        if (relevant.length > 0) {
          const snippets: string[] = [];
          for (const j of relevant.slice(0, 3)) {
            const jp = await readChunk(j.file_path);
            snippets.push(jp.content.slice(0, 100).trim());
          }
          journalSnippets = snippets;
        }
      }

      // Commit info
      const commitInfo = commitMap.get(chunk.id);
      const commit = commitInfo ? { id: commitInfo.id, message: commitInfo.message } : undefined;

      history.push({
        id: chunk.id,
        version: i + 1,
        createdAt: chunk.created_at,
        supersedes: chunk.supersedes_id,
        supersededBy: supersededBy?.id ?? null,
        content: parsed.content,
        narrative,
        drift,
        journalSnippets,
        commit,
      });
    }

    return { concept, history };
  }

  async rebuild(opts?: { codePath?: string }) {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const result = await rebuildFromDisk(db, entry.lore_path, config);
    await rebuildLanceIndex(db);
    return result;
  }

  async reEmbed(opts?: {
    codePath?: string;
    onProgress?: (
      phase: "text" | "code" | "graph",
      current: number,
      total: number,
      model?: string,
    ) => void;
  }): Promise<{
    reEmbedded: number;
    codeEmbedded: number;
    deleted: number;
    textModel: string;
    codeModel: string | null;
  }> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const embedder = await this.embedderFor(config, entry);

    const { deleteAllEmbeddings: deleteAllEmb } = await import("@/db/embeddings.ts");
    const {
      embeddingFilePath: embPath,
      writeEmbeddingFile: writeEmb,
      deleteEmbeddingFile: deleteEmb,
    } = await import("@/storage/embedding-io.ts");
    const { readChunk: readChunkFn } = await import("@/storage/chunk-reader.ts");
    const { insertEmbedding: insertEmb } = await import("@/db/embeddings.ts");

    const textModel = config.ai.embedding.model;
    const codeEmbedder = await this.codeEmbedderFor(config, entry);
    const resolvedCodeModel = codeEmbedder ? (config.ai.embedding.code?.model ?? null) : null;

    // 1. Delete all embeddings from DB
    deleteAllEmb(db);

    // 2. Collect chunks for each pass
    const proseChunks = db
      .query<{ id: string; file_path: string }, []>(
        `SELECT id, file_path FROM chunks WHERE fl_type != 'source'`,
      )
      .all();
    const sourceChunks = db
      .query<{ id: string; file_path: string }, []>(
        `SELECT id, file_path FROM chunks WHERE fl_type = 'source'`,
      )
      .all();

    // 3. Delete all .emb sidecar files for prose chunks
    let deleted = 0;
    for (const chunk of proseChunks) {
      const embFile = embPath(chunk.file_path);
      if (await deleteEmb(embFile)) deleted++;
    }

    // 4. Pre-read all contents concurrently; drop empty chunks — embedding
    // providers reject empty strings and there is nothing to retrieve anyway.
    const EMBED_BATCH_SIZE = 96;
    const [proseContents, sourceContents] = await Promise.all([
      Promise.all(proseChunks.map((c) => readChunkFn(c.file_path).then((p) => p.content))),
      Promise.all(sourceChunks.map((c) => readChunkFn(c.file_path).then((p) => p.content))),
    ]);
    const prosePairs = proseChunks
      .map((chunk, i) => ({ chunk, content: proseContents[i]! }))
      .filter((p) => p.content.trim().length > 0);
    const sourcePairs = sourceChunks
      .map((chunk, i) => ({ chunk, content: sourceContents[i]! }))
      .filter((p) => p.content.trim().length > 0);

    // 5. Run text and code embedding passes concurrently
    // Both passes call different remote APIs; DB writes are serialized by the event loop.
    let reEmbedded = 0;
    let codeEmbedded = 0;

    const textPass = async () => {
      for (let i = 0; i < prosePairs.length; i += EMBED_BATCH_SIZE) {
        const batch = prosePairs.slice(i, i + EMBED_BATCH_SIZE);
        const batchEmbeddings = await embedder.embedBatch(batch.map((p) => p.content));
        for (let j = 0; j < batch.length; j++) {
          const { chunk } = batch[j]!;
          const embedding = batchEmbeddings[j]!;
          insertEmb(db, chunk.id, embedding, textModel);
          await writeEmb(embPath(chunk.file_path), textModel, embedding);
          reEmbedded++;
          opts?.onProgress?.("text", reEmbedded, prosePairs.length, textModel);
        }
      }
    };

    const codePass = async () => {
      if (!codeEmbedder || !resolvedCodeModel) return;

      const { insertSymbolEmbedding, deleteAllSymbolEmbeddings } =
        await import("@/db/embeddings.ts");
      const { getSymbolLinesForConcept } = await import("@/db/concept-symbols.ts");
      const { readSymbolContent } = await import("./git.ts");

      // Keep symbol embeddings current for ground_residual computation
      deleteAllSymbolEmbeddings(db);
      const concepts = db
        .query<{ id: string }, []>("SELECT DISTINCT concept_id AS id FROM concept_symbols")
        .all();
      const allSymbols: { symbolId: string; content: string }[] = [];
      for (const concept of concepts) {
        const symbolLines = getSymbolLinesForConcept(db, concept.id);
        for (const sym of symbolLines) {
          const content = await readSymbolContent(
            entry.code_path,
            sym.file_path,
            sym.line_start,
            sym.line_end,
          );
          if (content) allSymbols.push({ symbolId: sym.symbol_id, content });
        }
      }
      for (let i = 0; i < allSymbols.length; i += EMBED_BATCH_SIZE) {
        const batch = allSymbols.slice(i, i + EMBED_BATCH_SIZE);
        try {
          const batchEmbeddings = await codeEmbedder.embedBatch(batch.map((s) => s.content));
          for (let j = 0; j < batch.length; j++) {
            insertSymbolEmbedding(db, batch[j]!.symbolId, batchEmbeddings[j]!, resolvedCodeModel);
          }
        } catch {
          // Non-fatal: symbol embeddings are for ground_residual only
        }
      }

      // Embed source chunks with code model
      for (let i = 0; i < sourcePairs.length; i += EMBED_BATCH_SIZE) {
        const batch = sourcePairs.slice(i, i + EMBED_BATCH_SIZE);
        try {
          const batchEmbeddings = await codeEmbedder.embedBatch(batch.map((p) => p.content));
          for (let j = 0; j < batch.length; j++) {
            insertEmb(db, batch[j]!.chunk.id, batchEmbeddings[j]!, resolvedCodeModel);
            codeEmbedded++;
            opts?.onProgress?.("code", codeEmbedded, sourcePairs.length, resolvedCodeModel);
          }
        } catch (err) {
          throw new Error(
            `Code embedding failed on batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} (source chunks ${i + 1}-${Math.min(i + EMBED_BATCH_SIZE, sourcePairs.length)}/${sourcePairs.length}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    await Promise.all([textPass(), codePass()]);

    // 6. Recompute edges if we have enough state chunk embeddings
    if (reEmbedded >= 2) {
      opts?.onProgress?.("graph", 0, 1);
      const { discoverConcepts: discover } = await import("./concept-discovery.ts");
      const generator = await this.generatorFor(config, entry);
      await discover(db, generator);
      opts?.onProgress?.("graph", 1, 1);
    }

    await rebuildLanceIndex(db);

    return { reEmbedded, codeEmbedded, deleted, textModel, codeModel: resolvedCodeModel };
  }

  migrate(opts?: { codePath?: string }): { applied: number } {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return { applied: runMigrate(db) };
  }

  migrateStatus(opts?: { codePath?: string }): MigrationStatus {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return getMigrationStatus(db);
  }

  repair(opts?: { codePath?: string } & SchemaRepairOptions): SchemaRepairResult {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return repairSchema(db, { check: opts?.check });
  }

  /**
   * Delete rows left behind by chunks and symbols that no longer exist, then
   * reclaim the pages. One-shot repair for minds written before chunk and
   * symbol replacement cleared their own dependents. Retrieval does not change:
   * the read paths reach a row through its parent, so these rows were already
   * invisible.
   *
   * The prune covers the Lance search index too. Lance keeps every version of a
   * table it rewrites, so the store grows with each sync that removes rows, and
   * nothing else on the write path returns those files to the filesystem.
   */
  async pruneOrphans(opts?: { codePath?: string; check?: boolean }): Promise<PruneOrphansResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const dbPath = join(entry.lore_path, "lore.db");
    const bytesBefore = statSync(dbPath).size;

    if (opts?.check) {
      const chunkRows = countOrphanedChunkRows(db);
      const symbolRows = countOrphanedSymbolRows(db);
      const lanceSpace = await getLanceSpace(lanceDir(entry.lore_path));
      return {
        mode: "check",
        orphans: { ...chunkRows, ...symbolRows },
        total: sumOrphanedChunkRows(chunkRows) + sumOrphanedSymbolRows(symbolRows),
        db_bytes_before: bytesBefore,
        db_bytes_after: bytesBefore,
        lance_bytes_before: lanceSpace.on_disk_bytes,
        lance_bytes_after: lanceSpace.on_disk_bytes,
        lance_superseded_bytes: lanceSpace.superseded_bytes,
      };
    }

    const chunkRows = deleteOrphanedChunkRows(db);
    const symbolRows = deleteOrphanedSymbolRows(db);
    const orphans = { ...chunkRows, ...symbolRows };
    const total = sumOrphanedChunkRows(chunkRows) + sumOrphanedSymbolRows(symbolRows);
    // A plain DELETE returns the pages to the free list and leaves the file its
    // old size. VACUUM rewrites the file without them.
    if (total > 0) vacuumDb(db);

    // Compact whatever the retention window allows. The count of orphan rows
    // does not gate this: superseded Lance versions come from every rewrite,
    // not only from the rows this prune deleted.
    const compacted = await compactLanceIndex(lanceDir(entry.lore_path));
    const lanceSpaceAfter = await getLanceSpace(lanceDir(entry.lore_path));

    return {
      mode: "apply",
      orphans,
      total,
      db_bytes_before: bytesBefore,
      db_bytes_after: statSync(dbPath).size,
      lance_bytes_before: compacted.bytes_before,
      lance_bytes_after: compacted.bytes_after,
      lance_superseded_bytes: lanceSpaceAfter.superseded_bytes,
    };
  }

  vacuum(opts?: { codePath?: string }): VacuumResult {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return vacuumDb(db);
  }

  async healthCheck(_opts?: { codePath?: string }) {
    const config = this.configFor();
    const embedder = await this.embedderFor(config);

    // Check each registered lore mind
    const lore_minds = listLoreMinds(this.registry);
    const loreMindReports = lore_minds.map((loreMind) => {
      const db = this.dbFor(loreMind.lore_path);
      const manifest = getManifest(db);
      const openNarrativesList = getActiveNarratives(db);
      return {
        name: loreMind.name,
        loreExists: existsSync(loreMind.lore_path),
        manifestOk: manifest != null,
        openNarratives: openNarrativesList.length,
      };
    });

    const aiOk = await embedder.healthCheck();

    return {
      dbOk: true,
      aiOk,
      lore_minds: loreMindReports,
    };
  }

  // ─── Commit Operations ─────────────────────────────────

  commitLog(opts?: { codePath?: string; limit?: number; since?: string }): CommitLogEntry[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    let commits = walkHistory(db, undefined, opts?.since ? undefined : (opts?.limit ?? 50));

    if (opts?.since) {
      const sinceCommit = resolveRef(db, opts.since);
      if (sinceCommit) {
        commits = commits.filter((c) => c.committed_at >= sinceCommit.committed_at);
      }
      if (opts.limit) {
        commits = commits.slice(0, opts.limit);
      }
    }

    return commits.map((commit) => {
      const entry: CommitLogEntry = {
        id: commit.id,
        message: commit.message,
        committedAt: commit.committed_at,
        parentId: commit.parent_id,
      };

      // Enrich with narrative info
      if (commit.narrative_id) {
        const narrative = getNarrative(db, commit.narrative_id);
        if (narrative) {
          entry.narrative = {
            name: narrative.name,
            intent: narrative.intent,
            entryCount: narrative.entry_count,
          };
        }
      }

      // Parse lifecycle type
      const lifecycle = parseLifecycleMessage(commit.message);
      if (lifecycle) {
        entry.lifecycleType = lifecycle.type;
      }

      // Compute per-commit diff
      if (commit.parent_id) {
        try {
          const treeDiff = diffCommitTrees(db, commit.parent_id, commit.id);
          entry.diff = {
            added: treeDiff.added.map((a) => a.conceptName),
            modified: treeDiff.modified.map((m) => m.conceptName),
            removed: treeDiff.removed.map((r) => r.conceptName),
          };
        } catch {
          // Skip diff if parent commit not found
        }
      }

      return entry;
    });
  }

  private async showAtCommit(db: Database, ref: string, conceptName: string) {
    const commit = resolveRef(db, ref);
    if (!commit) {
      throw new LoreError("COMMIT_NOT_FOUND", `Cannot resolve ref '${ref}'`);
    }
    const tree = getCommitTreeAsMap(db, commit.id);
    const concept = getActiveConceptByName(db, conceptName);
    if (!concept) {
      throw new LoreError("CONCEPT_NOT_FOUND", `Concept '${conceptName}' not found`);
    }
    const chunkId = tree.get(concept.id);
    if (!chunkId) {
      return { concept, content: null, commit };
    }
    const chunkRow = getChunk(db, chunkId);
    if (!chunkRow) return { concept, content: null, commit };
    const parsed = await readChunk(chunkRow.file_path);
    const historicalContent = parsed.content;

    // Compute diff vs current content
    let diff_from_current:
      | {
          hunks: DiffHunk[];
          adds: number;
          removes: number;
        }
      | undefined;
    if (historicalContent) {
      try {
        const currentChunkId = concept.active_chunk_id;
        if (currentChunkId && currentChunkId !== chunkId) {
          const currentChunkRow = getChunk(db, currentChunkId);
          if (currentChunkRow) {
            const currentParsed = await readChunk(currentChunkRow.file_path);
            if (
              currentParsed.content &&
              !isDiffTooLarge(historicalContent, currentParsed.content)
            ) {
              const hunks = computeLineDiff(historicalContent, currentParsed.content);
              if (hunks.length > 0) {
                let adds = 0;
                let removes = 0;
                for (const hunk of hunks) {
                  for (const line of hunk.lines) {
                    if (line.type === "add") adds++;
                    else if (line.type === "remove") removes++;
                  }
                }
                diff_from_current = { hunks, adds, removes };
              }
            }
          }
        }
      } catch {
        // diff is best-effort
      }
    }

    return { concept, content: historicalContent, commit, diff_from_current };
  }

  async diffCommits(
    fromRef: string,
    toRef: string,
    opts?: { codePath?: string; includeContent?: boolean },
  ): Promise<TreeDiff> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const fromCommit = resolveRef(db, fromRef);
    const toCommit = resolveRef(db, toRef);
    if (!fromCommit) {
      throw new LoreError("COMMIT_NOT_FOUND", `Cannot resolve ref '${fromRef}'`);
    }
    if (!toCommit) {
      throw new LoreError("COMMIT_NOT_FOUND", `Cannot resolve ref '${toRef}'`);
    }
    const diff = diffCommitTrees(db, fromCommit.id, toCommit.id);

    // Enrich with narrative context from the toCommit
    if (toCommit.narrative_id) {
      const narrative = getNarrative(db, toCommit.narrative_id);
      if (narrative) {
        diff.narrative = {
          name: narrative.name,
          intent: narrative.intent,
          entryCount: narrative.entry_count,
        };
      }
    }

    // Walk commits between from and to, collecting lifecycle events
    const lifecycleEvents: NonNullable<TreeDiff["lifecycleEvents"]> = [];
    const between = walkHistory(db, toCommit.id, 200);
    for (const commit of between) {
      if (commit.id === fromCommit.id) break;
      const parsed = parseLifecycleMessage(commit.message);
      if (parsed) {
        lifecycleEvents.push({
          type: parsed.type,
          description: parsed.description,
          committedAt: commit.committed_at,
        });
      }
    }
    if (lifecycleEvents.length > 0) {
      diff.lifecycleEvents = lifecycleEvents;
    }

    // Content (opt-in to avoid unnecessary I/O)
    if (opts?.includeContent) {
      for (const added of diff.added) {
        try {
          const chunk = getChunk(db, added.chunkId);
          if (chunk) {
            const parsed = await readChunk(chunk.file_path);
            added.newContent = parsed.content;
            added.contentPreview = parsed.content.slice(0, 200);
          }
        } catch {
          // Skip if chunk file unreadable
        }
      }
      for (const mod of diff.modified) {
        try {
          const newChunk = getChunk(db, mod.toChunkId);
          const oldChunk = getChunk(db, mod.fromChunkId);
          if (newChunk) {
            const newParsed = await readChunk(newChunk.file_path);
            mod.newContent = newParsed.content;
            mod.contentPreview = newParsed.content.slice(0, 200);
            if (oldChunk) {
              const oldParsed = await readChunk(oldChunk.file_path);
              mod.oldContent = oldParsed.content;
              mod.lengthDelta = newParsed.content.length - oldParsed.content.length;
            }
          }
        } catch {
          // Skip if chunk file unreadable
        }
      }
    }

    return diff;
  }

  /** Dry-run: show what close would produce without applying. */
  async dryRunClose(narrativeName: string, opts?: { codePath?: string }) {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const narrative = getNarrativeByName(db, narrativeName);
    if (!narrative || (narrative.status !== "open" && narrative.status !== "close_failed")) {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
    }
    const plan = await buildExplicitClosePlan(
      db,
      narrative,
      await this.generatorFor(config, entry),
    );
    return {
      narrative,
      plan: {
        updates: plan.updates,
        creates: plan.creates,
      },
      unresolved_entries: plan.unresolvedEntries.length > 0 ? plan.unresolvedEntries : undefined,
    };
  }

  async designateJournalEntry(
    narrativeName: string,
    chunkId: string,
    opts: { concepts?: string[]; codePath?: string },
  ): Promise<JournalDesignationResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const current = getNarrativeByName(db, narrativeName);
    if (!current || (current.status !== "open" && current.status !== "close_failed")) {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
    }
    const narrative =
      current.status === "close_failed"
        ? (reopenNarrative(db, current.id), getNarrative(db, current.id))
        : current;
    if (!narrative) {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
    }

    const chunk = getJournalChunksForNarrative(db, narrative.id).find(
      (item) => item.id === chunkId,
    );
    if (!chunk) {
      throw new LoreError(
        "CHUNK_NOT_FOUND",
        `No journal chunk '${chunkId}' exists in open narrative '${narrativeName}'`,
      );
    }

    const resolved = resolveJournalConceptDesignations(db, narrative, opts.concepts);
    const parsed = await readChunk(chunk.file_path);
    const existingTopics =
      "fl_topics" in parsed.frontmatter && Array.isArray(parsed.frontmatter.fl_topics)
        ? (parsed.frontmatter.fl_topics as string[])
        : [];
    const nextTopics = existingTopics.length > 0 ? existingTopics : resolved.designations;

    await updateChunkFrontmatter(chunk.file_path, {
      fl_concept_designations: resolved.designations,
      fl_concept_refs: resolved.conceptRefs.length > 0 ? resolved.conceptRefs : null,
      fl_topics: nextTopics,
    });
    updateJournalChunkRouting(db, {
      chunkId: chunk.id,
      conceptDesignations: resolved.designations,
      conceptRefs: resolved.conceptRefs,
    });

    return {
      narrative: narrative.name,
      chunk_id: chunk.id,
      concepts: resolved.designations,
      note:
        existingTopics.length > 0
          ? "Journal designations updated."
          : "Journal designations updated. Topics defaulted to the designated concepts.",
    };
  }

  // ─── Repo Management ──────────────────────────────────

  listLoreMinds(): Array<{ name: string } & RegistryEntry> {
    return listLoreMinds(this.registry);
  }

  resetLoreMind(opts?: { codePath?: string }): { name: string; lorePath: string } {
    const cwd = opts?.codePath ? resolve(opts.codePath) : process.cwd();
    const found = findLoreMindByCodePath(this.registry, cwd);
    if (!found) {
      throw new LoreError(
        "LORE_NOT_REGISTERED",
        `This path is not registered as a lore (${cwd}). Run 'lore init' first.`,
      );
    }
    const lorePath = found.entry.lore_path;

    // Close cached DB connection if open
    const db = this.dbs.get(lorePath);
    if (db) {
      db.close();
      this.dbs.delete(lorePath);
    }

    // Wipe everything inside the lore path
    if (existsSync(lorePath)) {
      rmSync(lorePath, { recursive: true });
    }

    // Recreate the directory so the next dbFor() call works cleanly
    mkdirSync(lorePath, { recursive: true });

    return { name: found.name, lorePath };
  }

  removeLoreMind(name: string, deleteData: boolean = true): void {
    const entry = this.registry.lore_minds[name];
    if (!entry) {
      throw new LoreError("LORE_NOT_FOUND", `No lore named '${name}'`);
    }
    const db = this.dbs.get(entry.lore_path);
    if (db) {
      db.close();
      this.dbs.delete(entry.lore_path);
    }
    this.registry = removeLoreMindFromRegistry(this.globalConfig.lore_root, this.registry, name);
    if (deleteData && existsSync(entry.lore_path)) {
      rmSync(entry.lore_path, { recursive: true });
    }
  }

  // ─── Per-Repo Config ──────────────────────────────────

  listProviderCredentials(): Array<{ provider: SharedProvider; config: ProviderCredential }> {
    return listProviderConfigs(this.registry);
  }

  getProviderCredential(provider: SharedProvider): ProviderCredential | undefined {
    return getProviderConfig(this.registry, provider);
  }

  /**
   * List a provider's models, resolving the key and base URL the same way a
   * generation call would: an explicit option first, then the shared
   * credential, then whichever configured role already points at this provider.
   */
  /**
   * Resolve a provider's key and base URL the way a generation call would: an
   * explicit credential first, then whichever configured role already points at
   * this provider.
   */
  private credentialsFor(provider: SharedProvider): { api_key?: string; base_url?: string } {
    // Global config, not per-lore: you list models to choose one, which is
    // often before any lore is registered.
    const config = this.configFor();
    const credential = getProviderConfig(this.registry, provider);
    const roles = [config.ai.generation, config.ai.embedding].filter(
      (role) => role.provider === provider,
    );
    const fromRole = (key: "api_key" | "base_url"): string | undefined => {
      for (const role of roles) {
        const value = role[key];
        if (value) return value;
      }
      return undefined;
    };
    return {
      api_key: credential?.api_key ?? fromRole("api_key"),
      base_url: credential?.base_url ?? fromRole("base_url"),
    };
  }

  /** Every provider, with whether it is configured and what this lore uses it for. */
  listProviders(): ProviderStatus[] {
    // A lore may not be registered here; the roster is still worth showing.
    let usedBy: Partial<Record<SharedProvider, string[]>> = {};
    try {
      const { entry } = this.resolveLoreMind();
      const config = this.configFor(entry);
      const generation: SharedProvider = config.ai.generation.provider;
      const embedding: SharedProvider = config.ai.embedding.provider;
      usedBy = { [generation]: ["generation"] };
      usedBy[embedding] = [...(usedBy[embedding] ?? []), "embedding"];
    } catch {
      usedBy = {};
    }

    return ALL_PROVIDERS.map((provider) => {
      const credential = getProviderConfig(this.registry, provider);
      return {
        provider,
        has_key: Boolean(credential?.api_key),
        base_url: credential?.base_url,
        has_catalog: hasCatalog(provider),
        catalog_needs_key: CATALOG_NEEDS_KEY.includes(provider),
        catalog_needs_base_url: catalogNeedsBaseUrl(provider),
        used_by: usedBy[provider] ?? [],
      };
    });
  }

  async listProviderModels(
    provider: SharedProvider,
    opts: Omit<ListProviderModelsOptions, "api_key" | "base_url"> = {},
  ): Promise<ProviderModelPage> {
    return listProviderModels(provider, { ...this.credentialsFor(provider), ...opts });
  }

  /**
   * Search every provider that can be listed right now: it has a catalog, and
   * either needs no key or has one. Providers that would certainly fail are
   * left out rather than reported as failures.
   */
  /**
   * What this lore has spent on AI calls.
   *
   * Tokens come from the local record; money is priced at report time from the
   * live catalog, because a price belongs to the model today, not to the call
   * that happened last month. A model the catalog does not know, or an
   * unreachable catalog, leaves the tokens and drops the cost.
   */
  async usageReport(
    opts: { codePath?: string; since?: string; all?: boolean } = {},
  ): Promise<LoreUsageReport[]> {
    const targets = opts.all
      ? listLoreMinds(this.registry)
      : [
          {
            name: this.resolveLoreMind(opts.codePath).name,
            ...this.resolveLoreMind(opts.codePath).entry,
          },
        ];

    const priced = new Map<string, ProviderModel>();
    const reports: LoreUsageReport[] = [];

    for (const target of targets) {
      const { db } = this.resolveLoreMind(target.code_path);
      const totals = usageTotals(db, opts.since);
      if (totals.length === 0 && opts.all) continue;

      for (const row of totals) {
        const cacheKey = `${row.provider}:${row.model}`;
        if (!priced.has(cacheKey)) {
          const provider = row.provider as SharedProvider;
          try {
            const page = await this.listProviderModels(provider, {
              search: row.model,
              limit: Number.MAX_SAFE_INTEGER,
              kinds: ["generation", "embedding", "other"],
            });
            const match = page.models.find((m) => m.id === row.model);
            if (match) priced.set(cacheKey, match);
          } catch {
            // Offline or no catalog: report tokens without money.
          }
          if (!priced.has(cacheKey)) {
            // OpenRouter leaves embedding models out of the bulk catalog while
            // still serving and pricing them. A miss there is not an answer.
            const single = await getProviderModel(
              provider,
              row.model,
              this.credentialsFor(provider),
            ).catch(() => null);
            if (single) priced.set(cacheKey, single);
          }
        }
      }

      reports.push({
        lore: target.name,
        code_path: target.code_path,
        first_seen: usageFirstSeen(db),
        lines: totals.map((row) => {
          const price = priced.get(`${row.provider}:${row.model}`);
          const inCost =
            price?.prompt_usd_per_mtok !== undefined
              ? (row.input_tokens / 1_000_000) * price.prompt_usd_per_mtok
              : undefined;
          const outCost =
            price?.completion_usd_per_mtok !== undefined
              ? (row.output_tokens / 1_000_000) * price.completion_usd_per_mtok
              : undefined;
          return {
            ...row,
            cost_usd:
              inCost === undefined && outCost === undefined
                ? undefined
                : (inCost ?? 0) + (outCost ?? 0),
          };
        }),
      });
    }

    return reports;
  }

  /** Read a provider's credit balance and spend. */
  async getProviderUsage(provider: SharedProvider): Promise<ProviderUsage> {
    return getProviderUsage(provider, this.credentialsFor(provider));
  }

  async listAllProviderModels(
    opts: Omit<ListProviderModelsOptions, "api_key" | "base_url"> = {},
  ): Promise<ProviderModelPage> {
    const listable = this.listProviders()
      .filter((row) => row.has_catalog)
      .filter((row) => !row.catalog_needs_key || row.has_key)
      .filter((row) => !row.catalog_needs_base_url || Boolean(row.base_url))
      .map((row) => ({ provider: row.provider, ...this.credentialsFor(row.provider) }));

    return listAllProviderModels(listable, opts);
  }

  /**
   * Point this lore at a model. Writes only the current project's config.
   *
   * Verification is the whole point: a mistyped id is otherwise silent until
   * the next ask fails.
   */
  async useModel(
    provider: SharedProvider,
    model: string,
    opts: {
      role?: "generation" | "embedding";
      dim?: number;
      verify?: boolean;
      scope?: "project" | "global";
      codePath?: string;
    } = {},
  ): Promise<{
    provider: SharedProvider;
    model: string;
    role: "generation" | "embedding";
    scope: "project" | "global";
  }> {
    const role = opts.role ?? "generation";
    const scope = opts.scope ?? "project";

    if (opts.verify !== false && hasCatalog(provider)) {
      const page = await listProviderModels(provider, {
        ...this.credentialsFor(provider),
        limit: Number.MAX_SAFE_INTEGER,
        kinds: ["generation", "embedding", "other"],
      });
      if (!page.models.some((candidate) => candidate.id === model)) {
        const near = page.models
          .filter((candidate) => candidate.id.includes(model) || model.includes(candidate.id))
          .slice(0, 3)
          .map((candidate) => candidate.id);
        const hint = near.length > 0 ? ` Close matches: ${near.join(", ")}.` : "";
        throw new LoreError(
          "CONFIG_INVALID",
          `Provider '${provider}' serves no model '${model}'.${hint}`,
        );
      }
    }

    const write = (key: string, value: unknown): void => {
      if (scope === "global") {
        setGlobalConfigValue(this.globalConfig.lore_root, key, value);
        return;
      }
      this.setLoreMindConfig(key, value, opts);
    };

    write(`ai.${role}.provider`, provider);
    write(`ai.${role}.model`, model);
    if (role === "embedding" && opts.dim !== undefined) {
      write("ai.embedding.dim", opts.dim);
    }
    return { provider, model, role, scope };
  }

  setProviderCredential(
    provider: SharedProvider,
    values: { api_key?: string; base_url?: string },
  ): ProviderCredential {
    const existing = getProviderConfig(this.registry, provider) ?? {};
    const next: ProviderCredential = {
      ...existing,
      ...(values.api_key !== undefined ? { api_key: values.api_key } : {}),
      ...(values.base_url !== undefined ? { base_url: values.base_url } : {}),
    };
    this.registry = updateProviderConfig(
      this.globalConfig.lore_root,
      this.registry,
      provider,
      next,
    );
    return next;
  }

  unsetProviderCredential(
    provider: SharedProvider,
    fields?: { api_key?: boolean; base_url?: boolean },
  ): ProviderCredential | undefined {
    const existing = getProviderConfig(this.registry, provider);
    if (!existing) return undefined;
    const dropApiKey = fields?.api_key ?? true;
    const dropBaseUrl = fields?.base_url ?? true;
    const next: ProviderCredential = {
      ...existing,
      ...(dropApiKey ? { api_key: undefined } : {}),
      ...(dropBaseUrl ? { base_url: undefined } : {}),
    };
    const normalized =
      next.api_key === undefined && next.base_url === undefined
        ? undefined
        : {
            ...(next.api_key !== undefined ? { api_key: next.api_key } : {}),
            ...(next.base_url !== undefined ? { base_url: next.base_url } : {}),
          };
    this.registry = updateProviderConfig(
      this.globalConfig.lore_root,
      this.registry,
      provider,
      normalized,
    );
    return normalized;
  }

  getLoreMindConfig(opts?: { codePath?: string }): {
    config: Partial<LoreConfig> | undefined;
    resolved: LoreConfig;
  } {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    const config = loadLocalConfig(entry.code_path) as Partial<LoreConfig>;
    return {
      config: Object.keys(config).length > 0 ? config : undefined,
      resolved: this.configFor(entry),
    };
  }

  getPromptPreview(
    key: GenerationPromptKey | "all",
    opts?: { codePath?: string },
  ): PromptPreviewResult[] {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const existingConcepts = getActiveConcepts(db)
      .map((c) => c.name)
      .slice(0, 8);
    const conceptName = existingConcepts[0] ?? "example-concept";
    const targetParts = 2;

    const keys = key === "all" ? GENERATION_PROMPT_KEYS : [key];
    return keys.map((promptKey) => ({
      key: promptKey,
      guidance: config.ai.generation.prompts[promptKey].guidance,
      system: buildGenerationSystemPrompt(promptKey, config.ai.generation.prompts, {
        conceptName,
        targetParts,
        existingConcepts,
      }),
    }));
  }

  cloneLoreMindConfig(
    sourceLoreMindName: string,
    opts?: { codePath?: string },
  ): { source: string; target: string; hasConfig: boolean } {
    const { entry: targetEntry, name: targetLoreMindName } = this.resolveLoreMind(opts?.codePath);
    const sourceEntry = this.registry.lore_minds[sourceLoreMindName];
    if (!sourceEntry) {
      throw new LoreError("LORE_NOT_FOUND", `No lore named '${sourceLoreMindName}'`);
    }

    const clonedConfig = loadLocalConfig(sourceEntry.code_path);
    const hasConfig = Object.keys(clonedConfig).length > 0;

    if (hasConfig) {
      // Fail closed if source config contains invalid keys/values.
      resolveConfig(this.programmaticOverrides, clonedConfig as Partial<LoreConfig>);
    }
    // Always write to target: copies source config or clears existing target config.
    writeLocalConfig(targetEntry.code_path, clonedConfig);

    return {
      source: sourceLoreMindName,
      target: targetLoreMindName,
      hasConfig,
    };
  }

  setLoreMindConfig(key: string, value: unknown, opts?: { codePath?: string }): void {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    const config = loadLocalConfig(entry.code_path) as Record<string, unknown>;
    setDeepValue(config, key, value);
    resolveConfig(this.programmaticOverrides, config as Partial<LoreConfig>);
    writeLocalConfig(entry.code_path, config as DeepPartial<LoreConfig>);
  }

  unsetLoreMindConfig(key: string, opts?: { codePath?: string }): void {
    const { entry } = this.resolveLoreMind(opts?.codePath);
    const config = loadLocalConfig(entry.code_path) as Record<string, unknown>;
    deleteDeepValue(config, key);
    resolveConfig(this.programmaticOverrides, config as Partial<LoreConfig>);
    writeLocalConfig(entry.code_path, config as DeepPartial<LoreConfig>);
  }

  async suggest(opts?: {
    codePath?: string;
    limit?: number;
    kind?: SuggestionKind | SuggestionKind[];
  }): Promise<SuggestResult> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db, entry.lore_path);
    const config = this.configFor(entry);
    let generator: Generator | undefined;
    try {
      generator = await this.generatorFor(config, entry);
    } catch {
      // No generator configured — drift questions will be skipped
    }
    return computeSuggestions(
      db,
      entry.code_path,
      { limit: opts?.limit, kind: opts?.kind },
      { entry, config, generator },
    );
  }

  // ─── Source Code Scanner ─────────────────────────────────

  async rescan(opts?: { codePath?: string }): Promise<ScanResult> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    return rescanProject(db, entry.code_path, entry.lore_path);
  }

  async ingestDoc(filePath: string, opts?: { codePath?: string }): Promise<IngestResult> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    const { resolve, relative } = await import("path");
    const abs = resolve(filePath);
    const result = await ingestDocFile(db, entry.code_path, entry.lore_path, abs);
    markLanceDirty(db);
    await reclaimLanceSpace(lanceDir(entry.lore_path));
    return {
      files_ingested: result === "ingested" ? 1 : 0,
      files_skipped: result === "skipped" ? 1 : 0,
      files_removed: 0,
      files_failed: result === "failed" ? 1 : 0,
      failed_paths: result === "failed" ? [relative(entry.code_path, abs)] : [],
      duration_ms: 0,
    };
  }

  async ingestAll(opts?: {
    codePath?: string;
    force?: boolean;
  }): Promise<{ scan: ScanResult; ingest: IngestResult }> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    const scan = await rescanProject(db, entry.code_path, entry.lore_path, { force: opts?.force });
    const ingest = await ingestTextFiles(db, entry.code_path, entry.lore_path, {
      force: opts?.force,
    });
    await this.embedMissingChunks(db, entry);
    markLanceDirty(db);
    // The write side is where compaction belongs. The sync that supersedes a
    // Lance data file runs on the next search, so this pass clears what the
    // last ingest left; a search never pays for a rewrite of the store.
    await reclaimLanceSpace(lanceDir(entry.lore_path));
    return { scan, ingest };
  }

  /**
   * Embed every chunk that lacks an embedding under the currently configured
   * models. Rescans mint new chunk ids (changed files, or re-chunking after a
   * scanner change), which orphans prior embeddings — without this, fresh code
   * is invisible to the vector lanes until a full manual reEmbed. Idempotent
   * and self-healing: it picks up whatever is missing, however it got missed.
   * Embedding-provider failures are logged and skipped — ingest must succeed
   * even when the embedder is down; the next ingest heals the remainder.
   */
  private async embedMissingChunks(db: Database, entry: RegistryEntry): Promise<void> {
    const config = this.configFor(entry);
    const missing = db
      .query<{ id: string; file_path: string; fl_type: string }, []>(
        `SELECT c.id, c.file_path, c.fl_type
         FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
         WHERE e.chunk_id IS NULL`,
      )
      .all();
    if (missing.length === 0) return;

    const { readChunk: readChunkFn } = await import("@/storage/chunk-reader.ts");
    const { insertEmbeddingBatch: insertBatch } = await import("@/db/embeddings.ts");

    const contents = await Promise.all(
      missing.map((c) =>
        readChunkFn(c.file_path).then(
          (p) => p.content,
          () => "",
        ),
      ),
    );
    const rows = missing
      .map((chunk, i) => ({ chunk, content: contents[i]! }))
      .filter((r) => r.content.trim().length > 0);

    const sourceRows = rows.filter((r) => r.chunk.fl_type === "source");
    const proseRows = rows.filter((r) => r.chunk.fl_type !== "source");
    const BATCH = 96;

    // Cap what goes to the embedder: one giant single-section doc (a postman
    // collection, a lockfile) otherwise 400s its whole batch. A vector of the
    // first 8k chars is still a useful retrieval key for such a file.
    const EMBED_INPUT_MAX = 8_000;
    const embedRows = async (batchRows: typeof rows, embedderInstance: Embedder, model: string) => {
      let failed = 0;
      for (let i = 0; i < batchRows.length; i += BATCH) {
        const batch = batchRows.slice(i, i + BATCH);
        const inputs = batch.map((r) => r.content.slice(0, EMBED_INPUT_MAX));
        try {
          const embeddings = await embedderInstance.embedBatch(inputs);
          insertBatch(
            db,
            batch.map((r, j) => ({ chunkId: r.chunk.id, embedding: embeddings[j]!, model })),
          );
        } catch {
          // One poison item must not abandon the batch, and one failed batch
          // must not abandon the rest of the run (it used to `return` here,
          // which left minds with zero prose embeddings — deterministically,
          // since the same batch failed first on every ingest). Isolate items;
          // skip only what genuinely will not embed.
          for (let j = 0; j < batch.length; j++) {
            try {
              const [embedding] = await embedderInstance.embedBatch([inputs[j]!]);
              insertBatch(db, [{ chunkId: batch[j]!.chunk.id, embedding: embedding!, model }]);
            } catch {
              failed++;
            }
          }
        }
      }
      if (failed > 0) {
        console.error(
          `lore: ${failed} chunk(s) failed to embed under ${model} and were skipped; a later ingest will retry them`,
        );
      }
    };

    if (proseRows.length > 0) {
      const embedder = await this.embedderFor(config, entry);
      await embedRows(proseRows, embedder, config.ai.embedding.model);
    }
    if (sourceRows.length > 0 && config.ai.embedding.code?.model) {
      const codeEmbedder = await this.codeEmbedderFor(config, entry);
      if (codeEmbedder) {
        await embedRows(sourceRows, codeEmbedder, config.ai.embedding.code.model);
      }
    }
  }

  symbolSearch(
    query: string,
    opts?: { codePath?: string; limit?: number; kind?: SymbolKind },
  ): SymbolSearchResult[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return searchSymbols(db, query, { limit: opts?.limit, kind: opts?.kind });
  }

  fileSymbols(filePath: string, opts?: { codePath?: string }): SymbolRow[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return getSymbolsForFilePath(db, filePath);
  }

  scanStats(opts?: { codePath?: string }): ScanStats {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return {
      file_count: getSourceFileCount(db),
      symbol_count: getSymbolCount(db),
      languages: getSourceFileLanguageCounts(db),
      last_scanned_at: getLastScannedAt(db),
    };
  }

  // ─── Concept-Symbol Bindings ──────────────────────────────

  conceptBindings(concept: string, opts?: { codePath?: string }): ConceptBindingSummary[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const row = resolveConceptByNameCi(db, concept, { activeOnly: true });
    return getBindingSummariesForConcept(db, row.id);
  }

  /** Bind one symbol, named by what a listing prints.
   *
   *  The search reads the whole index, because the symbol is not bound yet.
   *  A name repeats there — three methods answer to `open` — so several
   *  matches refuse and name the files rather than binding an arbitrary one.
   *  `filePath` chooses. This mirrors `unbindSymbol`, which searches the one
   *  concept instead. */
  bindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string; confidence?: number; filePath?: string },
  ): ConceptBindingSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptRow = resolveConceptByNameCi(db, concept, { activeOnly: true });
    const found = findSymbolsByName(db, symbolQualifiedName);
    const candidates = opts?.filePath
      ? found.filter((row) => row.file_path === opts.filePath)
      : found;
    if (candidates.length === 0) {
      const where = opts?.filePath ? ` in ${opts.filePath}` : "";
      throw new LoreError("CONCEPT_NOT_FOUND", `No symbol named '${symbolQualifiedName}'${where}`);
    }
    if (candidates.length > 1) {
      const places = candidates.map((row) => `${row.file_path}:${row.line_start}`).join(", ");
      throw new LoreError(
        "SYMBOL_AMBIGUOUS",
        `'${symbolQualifiedName}' names ${candidates.length} symbols. Pass --file with one of: ${places}`,
        { concept, symbol: symbolQualifiedName, candidates },
      );
    }
    const symbolRow = candidates[0]!;
    upsertConceptSymbol(db, {
      conceptId: conceptRow.id,
      symbolId: symbolRow.id,
      bindingType: "ref",
      boundBodyHash: symbolRow.body_hash,
      confidence: opts?.confidence ?? 1.0,
    });
    // File and line identify the row a reader named. The qualified name does
    // not: a short name matches no summary, and `LoreEngine.open` matches the
    // binding in every class that declares one.
    const summaries = getBindingSummariesForConcept(db, conceptRow.id);
    const match = summaries.find(
      (s) => s.file_path === symbolRow.file_path && s.line_start === symbolRow.line_start,
    );
    return match!;
  }

  /** Remove one binding, named by its symbol.
   *
   *  The match runs over this concept's own bindings. A global lookup by name
   *  returns one symbol of several that share it, and deleting by that symbol
   *  removes nothing whenever it picks the one nobody bound — the command then
   *  reported "no binding found" against a binding the listing still printed.
   *
   *  Two bindings on one concept can still share a name, in different files.
   *  That refuses and names the files: a caller passes `filePath` to choose.
   *  Deleting both would be a second guess at which one the caller meant. */
  unbindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string; filePath?: string },
  ): { removed: boolean } {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptRow = resolveConceptByNameCi(db, concept, { activeOnly: true });
    const bound = findBoundSymbolsByName(db, conceptRow.id, symbolQualifiedName);
    const matches = opts?.filePath ? bound.filter((row) => row.file_path === opts.filePath) : bound;
    if (matches.length === 0) {
      return { removed: false };
    }
    if (matches.length > 1) {
      const where = matches.map((row) => `${row.file_path}:${row.line_start}`).join(", ");
      throw new LoreError(
        "SYMBOL_AMBIGUOUS",
        `'${symbolQualifiedName}' is bound to ${concept} in ${matches.length} places. Pass --file with one of: ${where}`,
        { concept, symbol: symbolQualifiedName, matches },
      );
    }
    const removed = deleteConceptSymbol(db, conceptRow.id, matches[0]!.symbol_id);
    return { removed };
  }

  symbolDrift(opts?: { codePath?: string }): SymbolDriftResult[] {
    const { db } = this.resolveLoreMind(opts?.codePath);
    return getDriftedBindings(db);
  }

  async rebindAll(opts?: {
    codePath?: string;
  }): Promise<{ bound: number; byType: { ref: number; mention: number } }> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const activeConcepts = getActiveConcepts(db);
    const conceptIds = activeConcepts.map((c) => c.id);
    const result = await extractBindingsForConcepts(db, conceptIds);
    await autoBindSemantic(db, config, entry.code_path, { conceptIds });
    pruneOrphanedBindings(db);
    return result;
  }

  async autoBind(opts?: { codePath?: string }): Promise<AutoBindResult> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    return autoBindSemantic(db, config, entry.code_path);
  }

  coverageReport(opts?: { codePath?: string; limit?: number; filePath?: string }): CoverageReport {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const stats = getCoverageStats(db);
    const files = getFileCoverage(db);
    const uncovered = getUncoveredSymbols(db, {
      exportedOnly: true,
      limit: opts?.limit ?? 50,
      filePath: opts?.filePath,
    });
    const coverageRatio =
      stats.total_exported > 0 ? stats.bound_exported / stats.total_exported : 0;
    return { stats, coverage_ratio: coverageRatio, files, uncovered };
  }

  bootstrapPlan(opts?: { codePath?: string }): BootstrapPlan {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    return computeBootstrapPlan(db, entry.code_path);
  }
}
