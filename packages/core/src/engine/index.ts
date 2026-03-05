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
  type QueryResult,
  type RecallResult,
  type ExecutiveSummary,
  type CloseResult,
  type StatusResult,
  type ConceptRow,
  type ResolveDangling,
  type QueryOptions,
  type OrchestrationQueryOptions,
  type ReasoningLevel,
  type WebSearchResult,
  type TreeDiff,
  type CommitRow,
  type CommitLogEntry,
  type RelationType,
  type ConceptHealthComputeResult,
  type ConceptHealthExplainResult,
  type HealConceptsResult,
  type ConceptRelationSummary,
  type ConceptTagSummary,
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
  writeLocalConfig,
  seedGlobalConfigIfAbsent,
  type DeepPartial,
} from "@/config/index.ts";
import { openDb, runMigrations } from "@/db/index.ts";
import { migrate as runMigrate, getMigrationStatus, type MigrationStatus } from "@/db/migrator.ts";
import {
  getManifest,
  getPreviousManifest,
  upsertManifest,
  markGraphStale,
  getOpenNarratives,
  getDanglingNarratives,
  getNarrativeByName,
  getActiveConcepts,
  getPreviousConceptMetrics,
  getConcepts,
  getActiveConceptByName,
  getConceptsByNameCaseInsensitive,
  isConceptNameTaken,
  insertConceptVersion,
  insertConcept,
  getActiveConceptCount,
  getChunksForConcept,
  getChunk,
  insertChunk,
  getChunkCount,
  getNarrative,
  getEmbeddingForChunk,
  insertEmbedding,
  getJournalChunksForNarrative,
  getAllNarratives,
  rebuildFromDisk,
  insertFtsContent,
  repairSchema,
  walkHistory,
  getHeadCommit,
  insertCommit,
  insertCommitTree,
  resolveRef,
  diffCommitTrees,
  getCommitTreeAsMap,
  upsertConceptRelation,
  deactivateConceptRelation,
  getConceptRelations,
  upsertConceptTag,
  removeConceptTag,
  getConceptTags,
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
  getConcept,
  parseLifecycleMessage,
  getLastNarrativeForConcept,
  insertQueryCache,
  getQueryCache,
  scoreQueryCache,
} from "@/db/index.ts";
import { getEdges } from "@/db/edges.ts";
import {
  loadRegistry,
  findLoreMindByCodePath,
  addLoreMind,
  listLoreMinds,
  removeLoreMind as removeLoreMindFromRegistry,
  listProviderConfigs,
  getProviderConfig,
  updateProviderConfig,
} from "@/storage/registry.ts";
import {
  ensureDir,
  writeStateChunk,
  markSuperseded,
  updateChunkFrontmatter,
  writeEmbeddingFile,
  embeddingFilePath,
} from "@/storage/index.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { rmSync } from "fs";
import { GENERATION_PROMPT_KEYS, type GenerationPromptKey } from "@/config/prompts.ts";
import { computeLineDiff, isDiffTooLarge, type DiffHunk } from "./line-diff.ts";
import { Embedder } from "./embedder.ts";
import { Generator, buildGenerationSystemPrompt } from "./generator.ts";
import { AskTracer } from "./tracer.ts";
import {
  openNarrative,
  logEntry,
  queryConcepts,
  generateExecutiveSummary,
  closeNarrativeOp,
  discardNarrative,
  createGenesisCommit,
} from "./narrative-lifecycle.ts";
import { analyzeJournal } from "./integration.ts";
import { computeTotalDebt, cosineDistance } from "./residuals.ts";
import { computeDebtTrend } from "./residuals.ts";
import { discoverConcepts } from "./concept-discovery.ts";
import { recomputeGraph } from "./graph.ts";
import {
  computeDebtSnapshot,
  conceptLiveStaleness,
  conceptPressure,
  type DebtSnapshot,
} from "./debt.ts";
import { computeAskDebtSnapshot } from "./ask-debt.ts";
import { webSearch } from "./web-search.ts";
import type {
  Registry,
  FileRef,
  ScanResult,
  ScanStats,
  SymbolSearchResult,
  SymbolRow,
  SymbolKind,
  ConceptSymbolRow,
  ConceptBindingSummary,
  SymbolDriftResult,
  CoverageReport,
  BootstrapPlan,
  NarrativeTrailEntry,
  NarrativeTrailResult,
  IngestResult,
} from "@/types/index.ts";
import type { SchemaRepairOptions, SchemaRepairResult } from "@/db/index.ts";
import {
  buildConceptHealthNeighbors,
  computeConceptHealthSignals,
  healSignal,
} from "./concept-health.ts";
import { ulid } from "ulid";
import { computeSuggestions } from "./suggest.ts";
import type { SuggestResult } from "@/types/index.ts";
import { scanProject, rescanProject } from "./scanner.ts";
import { discoverFiles } from "./file-discovery.ts";
import { extractBindingsForConcepts, pruneOrphanedBindings, autoBindSemantic } from "./binding-extraction.ts";
import type { AutoBindResult } from "./binding-extraction.ts";
import {
  searchSymbols,
  getSymbolsForFilePath,
  getSymbolByQualifiedName,
  getSymbolCount,
} from "@/db/symbols.ts";
import {
  getSourceFileCount,
  getSourceFileLanguageCounts,
  getLastScannedAt,
} from "@/db/source-files.ts";
import {
  getBindingsForConcept,
  getBindingSummariesForConcept,
  deleteConceptSymbol,
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
import {
  getSourceChunkCount,
  getDocChunkCount,
  getLastDocIndexedAt,
  getJournalEntryCount,
} from "@/db/chunks.ts";

interface LifecycleResult {
  action: "rename" | "archive" | "restore" | "merge" | "split" | "patch";
  commit_id: string | null;
  summary: string;
  affected: string[];
  preview?: boolean;
  proposal?: {
    source?: string;
    target?: string;
    merged_content?: string;
    splits?: Array<{ name: string; content: string }>;
  };
}

interface PromptPreviewResult {
  key: GenerationPromptKey;
  guidance: string;
  system: string;
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
      this.dbs.set(lorePath, db);
    }
    return db;
  }

  /** Resolve config with per-lore-mind overrides from local file */
  private configFor(entry?: RegistryEntry): LoreConfig {
    const loreMindConfig = entry ? loadLocalConfig(entry.code_path) as Record<string, unknown> : undefined;
    const resolved = resolveConfig(this.programmaticOverrides, loreMindConfig as Partial<LoreConfig> | undefined);
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

  private loreNameFor(entry?: RegistryEntry): string {
    if (!entry) return "lore";
    for (const [name, e] of Object.entries(this.registry.lore_minds)) {
      if (e.code_path === entry.code_path) return name;
    }
    return "lore";
  }

  private cachedEmbedder?: Embedder;
  private cachedGenerator?: Generator;
  private embedCacheKey?: string;
  private genCacheKey?: string;
  private cachedCodeEmbedder?: Embedder | null;
  private codeCacheKey?: string;

  private async embedderFor(config: LoreConfig, loreName?: string): Promise<Embedder> {
    const key = JSON.stringify({
      provider: config.ai.embedding.provider,
      model: config.ai.embedding.model,
      base_url: config.ai.embedding.base_url ?? "",
      api_key: config.ai.embedding.api_key ?? "",
      loreName: loreName ?? "",
    });
    if (!this.cachedEmbedder || this.embedCacheKey !== key) {
      this.cachedEmbedder = await Embedder.create(config, loreName);
      this.embedCacheKey = key;
    }
    return this.cachedEmbedder;
  }

  private async codeEmbedderFor(config: LoreConfig, loreName?: string): Promise<Embedder | null> {
    const code = config.ai.embedding.code;
    if (!code) return null;
    const key = JSON.stringify({
      provider: code.provider ?? config.ai.embedding.provider,
      model: code.model,
      base_url: code.base_url ?? config.ai.embedding.base_url ?? "",
      api_key: code.api_key ?? config.ai.embedding.api_key ?? "",
      loreName: loreName ?? "",
    });
    if (this.cachedCodeEmbedder === undefined || this.codeCacheKey !== key) {
      this.cachedCodeEmbedder = await Embedder.createForCode(config, loreName);
      this.codeCacheKey = key;
    }
    return this.cachedCodeEmbedder;
  }

  private async generatorFor(config: LoreConfig, loreName?: string): Promise<Generator> {
    const key = JSON.stringify({
      provider: config.ai.generation.provider,
      model: config.ai.generation.model,
      base_url: config.ai.generation.base_url ?? "",
      api_key: config.ai.generation.api_key ?? "",
      reasoning: config.ai.generation.reasoning ?? "none",
      prompts: config.ai.generation.prompts,
      loreName: loreName ?? "",
    });
    if (!this.cachedGenerator || this.genCacheKey !== key) {
      this.cachedGenerator = await Generator.create(config, loreName);
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

    // Check if already registered
    const existing = findLoreMindByCodePath(this.registry, absPath);
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
    opts?: { codePath?: string; resolveDangling?: ResolveDangling; targets?: NarrativeTarget[] },
  ): Promise<OpenResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    return openNarrative(
      db,
      entry.lore_path,
      narrativeName,
      intent,
      config,
      await this.embedderFor(config, this.loreNameFor(entry)),
      opts?.resolveDangling,
      opts?.targets,
    );
  }

  async log(
    narrativeName: string,
    text: string,
    opts: { topics?: string[]; codePath?: string; refs?: FileRef[]; concepts?: string[]; symbols?: string[] },
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

  private async runQuery(
    text: string,
    opts?: QueryOptions,
    internal?: {
      disablePerLoreMindSummary?: boolean;
      disableWeb?: boolean;
    },
  ): Promise<QueryResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const askId = ulid();
    const askTracer = config.debug?.ask?.trace ? new AskTracer(entry.lore_path, askId) : undefined;
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

    let summaryGenerator: Generator | undefined;
    if (summaryEnabled) {
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
      summaryGenerator = await this.generatorFor(summaryGenConfig, this.loreNameFor(entry));
    }

    opts?.onProgress?.("preparing embedder");
    const embedder = await this.embedderFor(config, this.loreNameFor(entry));
    const codeEmbedder = await this.codeEmbedderFor(config, this.loreNameFor(entry));

    // If source chunks exist, a code model is required — no silent fallback
    const sourceChunkCount =
      db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM chunks WHERE fl_type = 'source'`).get()
        ?.count ?? 0;
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
        db.query<{ c: number }, [string]>(
          `SELECT COUNT(*) c FROM embeddings e
           JOIN chunks ch ON e.chunk_id = ch.id
           WHERE ch.fl_type = 'source' AND e.model = ? LIMIT 1`,
        ).get(config.ai.embedding.code.model)?.c ?? 0;
      if (!hasCodeEmbeddings) {
        effectiveCodeEmbedder = null;
        askTracer?.log("lane.code", { skipped: true, reason: "no source embeddings" });
      }
    }

    const askDebtConcepts = getActiveConcepts(db);
    const askDebtManifest = getManifest(db);
    const askDebtRaw = await computeDebtSnapshot(entry, db, askDebtConcepts, askDebtManifest);
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
      codePath: entry.code_path,
      mode: opts?.mode,
      summary_generator: summaryGenerator,
      executive_summary: {
        enabled: summaryEnabled,
        model: summaryModel,
        reasoning: summaryReasoning,
        max_matches: summaryMaxMatches,
        max_chars: summaryMaxChars,
      },
      onProgress: opts?.onProgress,
      codeEmbedder: effectiveCodeEmbedder,
      tracer: askTracer,
      ask_debt: {
        score: askDebtSnapshot.debt,
        confidence: askDebtSnapshot.confidence,
        band: askDebtSnapshot.band,
      },
    });

    // Cache the result with a ULID for recall (shared with ask trace filename when tracing is on)
    result.result_id = askId;
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

    try { askTracer?.flush(); } catch {}

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
    });
  }

  recallResult(resultId: string, opts?: { codePath?: string }): RecallResult | null {
    const { db } = this.resolveLoreMind(opts?.codePath);
    try {
      const row = getQueryCache(db, resultId);
      if (!row) return null;
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

  scoreResult(resultId: string, score: number, opts?: { codePath?: string; scoredBy?: string }): void {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const ok = scoreQueryCache(db, resultId, score, opts?.scoredBy);
    if (!ok) {
      throw new LoreError("QUERY_CACHE_NOT_FOUND", `No cached result with id ${resultId}`);
    }
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
    const generator = await this.generatorFor(summaryGenConfig, this.loreNameFor(entry));

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

  async close(
    narrativeName: string,
    opts?: { codePath?: string; mode?: "merge" | "discard"; mergeStrategy?: MergeStrategy },
  ): Promise<CloseResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const mode = opts?.mode ?? "merge";

    if (mode === "discard") {
      return discardNarrative(db, narrativeName);
    }

    const config = this.configFor(entry);
    const embedder = await this.embedderFor(config, this.loreNameFor(entry));
    const generator = await this.generatorFor(config, this.loreNameFor(entry));

    const lifecycleTargetHandler = async (target: NarrativeTarget): Promise<void> => {
      const debtBefore = getManifest(db)?.debt ?? 0;
      switch (target.op) {
        case "rename": {
          const concept = this.resolveConceptByNameCi(db, target.from, { activeOnly: true });
          this.assertConceptNameAvailable(db, target.to, { excludeId: concept.id });
          insertConceptVersion(db, concept.id, { name: target.to });
          await this.updateActiveChunkMetadata(db, concept, { fl_concept: target.to });
          this.snapshotCurrentTree(db, `lifecycle: rename ${concept.name} -> ${target.to}`);
          this.updateManifestForLifecycle(db, debtBefore);
          break;
        }
        case "archive": {
          const concept = this.resolveConceptByNameCi(db, target.concept, { activeOnly: true });
          const now = new Date().toISOString();
          insertConceptVersion(db, concept.id, {
            active_chunk_id: null,
            lifecycle_status: "archived",
            archived_at: now,
            lifecycle_reason: target.reason ?? "archived",
            merged_into_concept_id: null,
          });
          await this.updateActiveChunkMetadata(db, concept, {
            fl_lifecycle_status: "archived",
            fl_archived_at: now,
            fl_lifecycle_reason: target.reason ?? "archived",
            fl_merged_into_concept_id: null,
          });
          this.snapshotCurrentTree(db, `lifecycle: archive ${concept.name}`);
          this.updateManifestForLifecycle(db, debtBefore);
          break;
        }
        case "restore": {
          const concept = this.resolveConceptByNameCi(db, target.concept);
          if (this.isActiveConcept(concept)) {
            throw new LoreError(
              "CONCEPT_INVALID_STATE",
              `Concept '${concept.name}' is already active`,
            );
          }
          this.assertConceptNameAvailable(db, concept.name, { excludeId: concept.id });
          const latestChunk = db
            .query<{ id: string }, [string]>(
              `SELECT id FROM chunks WHERE concept_id = ? AND fl_type = 'chunk' ORDER BY created_at DESC LIMIT 1`,
            )
            .get(concept.id);
          if (!latestChunk?.id) {
            throw new LoreError(
              "CONCEPT_INVALID_STATE",
              `Concept '${concept.name}' has no state chunks to restore`,
            );
          }
          insertConceptVersion(db, concept.id, {
            active_chunk_id: latestChunk.id,
            lifecycle_status: "active",
            archived_at: null,
            lifecycle_reason: null,
            merged_into_concept_id: null,
          });
          const restoredChunk = getChunk(db, latestChunk.id);
          if (restoredChunk) {
            await updateChunkFrontmatter(restoredChunk.file_path, {
              fl_lifecycle_status: "active",
              fl_archived_at: null,
              fl_lifecycle_reason: null,
              fl_merged_into_concept_id: null,
            });
          }
          await discoverConcepts(db, generator);
          this.snapshotCurrentTree(db, `lifecycle: restore ${concept.name}`);
          this.updateManifestForLifecycle(db, debtBefore);
          break;
        }
        case "merge": {
          const source = this.resolveConceptByNameCi(db, target.source, { activeOnly: true });
          const mergeTarget = this.resolveConceptByNameCi(db, target.into, { activeOnly: true });
          if (source.id === mergeTarget.id) {
            throw new LoreError(
              "CONCEPT_INVALID_STATE",
              "Source and target must be different concepts",
            );
          }
          const sourceContent = await this.readConceptContent(db, source);
          const targetContent = await this.readConceptContent(db, mergeTarget);
          const mergedContent = await generator.generateIntegration(
            [
              `Merge findings from concept "${source.name}" into "${mergeTarget.name}".\n\n${sourceContent}`,
            ],
            targetContent ? [targetContent] : [],
            mergeTarget.name,
          );
          await this.appendStateChunkForConcept(
            db,
            entry.lore_path,
            mergeTarget,
            mergedContent,
            `lifecycle-merge:${source.name}`,
            embedder,
            config.ai.embedding.model,
            { supersedesId: mergeTarget.active_chunk_id },
          );
          const now = new Date().toISOString();
          insertConceptVersion(db, source.id, {
            active_chunk_id: null,
            lifecycle_status: "merged",
            archived_at: now,
            lifecycle_reason: target.reason ?? `merged into ${mergeTarget.name}`,
            merged_into_concept_id: mergeTarget.id,
          });
          await this.updateActiveChunkMetadata(db, source, {
            fl_lifecycle_status: "merged",
            fl_archived_at: now,
            fl_lifecycle_reason: target.reason ?? `merged into ${mergeTarget.name}`,
            fl_merged_into_concept_id: mergeTarget.id,
          });
          await discoverConcepts(db, generator);
          this.snapshotCurrentTree(db, `lifecycle: merge ${source.name} -> ${mergeTarget.name}`);
          this.updateManifestForLifecycle(db, debtBefore);
          break;
        }
        case "split": {
          const source = this.resolveConceptByNameCi(db, target.concept, { activeOnly: true });
          const parts = Math.max(2, target.parts ?? 2);
          const sourceContent = await this.readConceptContent(db, source);
          const proposals = await generator.proposeSplit(source.name, sourceContent, parts);
          const uniqueProposalNames = new Set<string>();
          for (const proposal of proposals) {
            if (uniqueProposalNames.has(proposal.name.toLowerCase())) {
              throw new LoreError(
                "CONCEPT_NAME_CONFLICT",
                `Split generated duplicate concept name '${proposal.name}'`,
              );
            }
            uniqueProposalNames.add(proposal.name.toLowerCase());
            this.assertConceptNameAvailable(db, proposal.name);
          }
          const created: string[] = [];
          for (const proposal of proposals) {
            const newConcept = insertConcept(db, proposal.name);
            await this.appendStateChunkForConcept(
              db,
              entry.lore_path,
              newConcept,
              proposal.content,
              `lifecycle-split:${source.name}`,
              embedder,
              config.ai.embedding.model,
              { supersedesId: null },
            );
            created.push(proposal.name);
          }
          const now = new Date().toISOString();
          insertConceptVersion(db, source.id, {
            active_chunk_id: null,
            lifecycle_status: "archived",
            archived_at: now,
            lifecycle_reason: `split into ${created.join(", ")}`,
            merged_into_concept_id: null,
          });
          await this.updateActiveChunkMetadata(db, source, {
            fl_lifecycle_status: "archived",
            fl_archived_at: now,
            fl_lifecycle_reason: `split into ${created.join(", ")}`,
            fl_merged_into_concept_id: null,
          });
          await discoverConcepts(db, generator);
          this.snapshotCurrentTree(
            db,
            `lifecycle: split ${source.name} -> ${created.length} concepts`,
          );
          this.updateManifestForLifecycle(db, debtBefore);
          break;
        }
      }
    };

    const codeEmbedder = await this.codeEmbedderFor(config, this.loreNameFor(entry));
    return closeNarrativeOp(
      db,
      entry.lore_path,
      narrativeName,
      config,
      embedder,
      generator,
      entry.code_path,
      { lifecycleTargetHandler, mergeStrategy: opts?.mergeStrategy, codeEmbedder },
    );
  }

  async status(opts?: { codePath?: string }): Promise<StatusResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db);
    const config = this.configFor(entry);
    const manifest = getManifest(db);
    const concepts = getActiveConcepts(db);
    const openNarrativesList = getOpenNarratives(db);
    const danglingNarratives = getDanglingNarratives(db, config.thresholds.dangling_days);
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest);
    const { debt: rawDebt, refWarnings, refDriftScoreByConcept } = debtSnapshot;
    const debtPrevious = null;
    const debtChange = null;

    // Check embedding model mismatch
    const embeddingModels = db
      .query<{ model: string; cnt: number }, []>(
        `SELECT model, COUNT(*) as cnt FROM embeddings GROUP BY model`,
      )
      .all();
    const currentModel = config.ai.embedding.model;
    const currentCodeModel = config.ai.embedding.code?.model ?? null;
    const validModels = new Set([currentModel, ...(currentCodeModel ? [currentCodeModel] : [])]);
    const totalEmbeddings = embeddingModels.reduce((s, r) => s + r.cnt, 0);
    const matchingEmbeddings = embeddingModels
      .filter((r) => validModels.has(r.model))
      .reduce((s, r) => s + r.cnt, 0);
    const staleEmbeddings = totalEmbeddings - matchingEmbeddings;

    // Priorities: concepts with high pressure/staleness or live ref drift.
    const priorityConcepts = concepts
      .filter(
        (c) =>
          conceptPressure(c, refDriftScoreByConcept) > 0.3 ||
          (c.staleness ?? 0) > 0.5 ||
          (refDriftScoreByConcept.get(c.id) ?? 0) > 0,
      )
      .sort((a, b) => {
        return (
          conceptPressure(b, refDriftScoreByConcept) - conceptPressure(a, refDriftScoreByConcept)
        );
      })
      .slice(0, 5);

    const priorities = priorityConcepts.map((c) => {
      const staleRefs = refWarnings.get(c.id);
      let reason: string;
      if (staleRefs && staleRefs.length > 0) {
        reason = `Referenced files changed: ${staleRefs.join(", ")}`;
      } else if ((c.staleness ?? 0) > 0.5) {
        reason = `Not updated in a long time. Staleness: ${((c.staleness ?? 0) * 100).toFixed(0)}%`;
      } else {
        const pressure = conceptPressure(c, refDriftScoreByConcept);
        reason = `High pressure: ${(pressure * 100).toFixed(0)}% (ground=${((c.ground_residual ?? c.churn ?? 0) * 100).toFixed(0)}%, lore=${((c.lore_residual ?? 0) * 100).toFixed(0)}%)`;
      }
      const lastNarrative = getLastNarrativeForConcept(db, c.id);
      const chunkRow = c.active_chunk_id ? getChunk(db, c.active_chunk_id) : null;
      return {
        concept: c.name,
        action: staleRefs
          ? "update — source files changed"
          : conceptPressure(c, refDriftScoreByConcept) > 0.5
            ? "update docs"
            : "review",
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
    if (staleEmbeddings > 0) {
      const staleModels = embeddingModels
        .filter((r) => !validModels.has(r.model))
        .map((r) => r.model);
      priorities.push({
        concept: "(embeddings)",
        action: "refresh embeddings",
        reason: `${staleEmbeddings} embeddings use outdated model ${staleModels.join(", ")} (current: ${currentModel}). Run lore embeddings refresh.`,
        last_narrative: undefined,
        changed_at: undefined,
      });
    }

    const embeddingStatus =
      totalEmbeddings > 0
        ? {
            total: totalEmbeddings,
            current_model: matchingEmbeddings,
            stale: staleEmbeddings,
            model: currentModel,
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
      const lastDocIndexedAt = getLastDocIndexedAt(db);
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
      const docFiles = discoverTextFiles(entry.code_path, entry.lore_path);
      let staleDocFiles = 0;
      for (const file of docFiles) {
        try {
          if (statSync(file.absolutePath).mtimeMs > lastDocMs) staleDocFiles++;
        } catch {
          // file disappeared — skip
        }
      }

      lake = {
        source_chunks: getSourceChunkCount(db),
        source_files: getSourceFileCount(db),
        doc_chunks: getDocChunkCount(db),
        journal_entries: getJournalEntryCount(db),
        last_code_indexed_at: lastCodeIndexedAt,
        last_doc_indexed_at: lastDocIndexedAt,
        stale_source_files: staleSourceFiles,
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
          .query<{ avg: number | null }, []>(
            `SELECT AVG(confidence) as avg FROM concept_symbols`,
          )
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
            source_files: lake.source_files,
            stale_doc_files: lake.stale_doc_files,
            doc_chunks: lake.doc_chunks,
          }
        : null,
      embeddingStatus: embeddingStatus
        ? {
            total: embeddingStatus.total,
            stale: embeddingStatus.stale,
          }
        : null,
    });

    const health: StatusResult["health"] =
      askDebtSnapshot.debt <= 25 ? "good" : askDebtSnapshot.debt <= 50 ? "degrading" : "critical";

    return {
      health,
      summary: `${concepts.length} concepts, debt ${askDebtSnapshot.debt.toFixed(1)}%`,
      debt: askDebtSnapshot.debt,
      confidence: askDebtSnapshot.confidence,
      debt_band: askDebtSnapshot.band,
      raw_debt: rawDebt,
      raw_debt_breakdown: askDebtSnapshot.raw_debt_breakdown,
      debt_breakdown: {
        persisted: askDebtSnapshot.raw_debt_breakdown.persisted,
        live: askDebtSnapshot.raw_debt_breakdown.live,
        display: askDebtSnapshot.raw_debt_breakdown.display,
      },
      debt_components: {
        staleness: askDebtSnapshot.components.staleness,
        symbol_drift: askDebtSnapshot.components.symbol_drift,
        code_freshness: askDebtSnapshot.components.code_freshness,
        doc_freshness: askDebtSnapshot.components.doc_freshness,
        coverage_gap: askDebtSnapshot.components.coverage_gap,
        embedding_mismatch: askDebtSnapshot.components.embedding_mismatch,
        active_narrative_hygiene: askDebtSnapshot.components.active_narrative_hygiene,
        priority_pressure: askDebtSnapshot.components.priority_pressure,
        ask_debt_base: askDebtSnapshot.base_debt,
        write_activity_72h: {
          journal_entries: askDebtSnapshot.components.write_activity_72h.journal_entries,
          closed_narratives: askDebtSnapshot.components.write_activity_72h.closed_narratives,
        },
        narrative_hygiene_72h: {
          open_narratives: askDebtSnapshot.components.narrative_hygiene_72h.open_narratives,
          empty_open_narratives: askDebtSnapshot.components.narrative_hygiene_72h.empty_open_narratives,
          dangling_narratives: askDebtSnapshot.components.narrative_hygiene_72h.dangling_narratives,
        },
      },
      debt_previous: debtPrevious,
      debt_delta: debtChange,
      priorities,
      active_narratives: openNarrativesList.map((d) => ({
        name: d.name,
        entry_count: d.entry_count,
        theta: d.theta,
        note:
          d.entry_count < 3
            ? "Early stage"
            : d.convergence != null && d.convergence > config.thresholds.convergence
              ? "Converging"
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
      maintenance: this.computeMaintenance(db, concepts.length),
      suggestions,
      concept_health: {
        run_id: conceptHealth.run_id,
        computed_at: conceptHealth.computed_at,
        top_stale: conceptHealth.top_stale,
      },
      coverage,
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

  private computeMaintenance(db: Database, conceptCount: number): StatusResult["maintenance"] {
    if (conceptCount === 0) {
      return { status: "n/a", min_delta_rate: 0, current_rate: 0 };
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

    const status = currentRate >= minNarrativeRate ? "above-floor" : "below-floor";
    return {
      status,
      min_delta_rate: Math.round(minNarrativeRate * 10) / 10,
      current_rate: Math.round(currentRate * 10) / 10,
    };
  }

  private metricDelta(current: number | null | undefined, previous: number | null | undefined) {
    if (current == null || previous == null) return null;
    return current - previous;
  }

  private ensureGraphFresh(db: Database): void {
    const manifest = getManifest(db);
    if (manifest?.graph_stale) {
      recomputeGraph(db);
    }
  }

  private isActiveConcept(concept: ConceptRow): boolean {
    return concept.lifecycle_status == null || concept.lifecycle_status === "active";
  }

  private resolveConceptByNameCi(
    db: Database,
    name: string,
    opts?: { activeOnly?: boolean },
  ): ConceptRow {
    const matches = getConceptsByNameCaseInsensitive(db, name);
    if (matches.length === 0) {
      throw new LoreError("CONCEPT_NOT_FOUND", `Concept '${name}' not found`);
    }

    const exact = matches.filter((m) => m.name === name);
    const concept = exact.length === 1 ? exact[0]! : matches.length === 1 ? matches[0]! : null;
    if (!concept) {
      throw new LoreError("CONCEPT_NAME_CONFLICT", `Concept name '${name}' is ambiguous`);
    }

    if (opts?.activeOnly && !this.isActiveConcept(concept)) {
      throw new LoreError("CONCEPT_INVALID_STATE", `Concept '${concept.name}' is not active`);
    }

    return concept;
  }

  private assertConceptNameAvailable(
    db: Database,
    name: string,
    opts?: { excludeId?: string },
  ): void {
    if (!isConceptNameTaken(db, name, { excludeId: opts?.excludeId })) return;
    throw new LoreError("CONCEPT_NAME_CONFLICT", `Concept name '${name}' already exists`);
  }

  private ensureHeadCommit(db: Database): CommitRow {
    let head = getHeadCommit(db);
    if (!head) {
      head = createGenesisCommit(db);
    }
    return head;
  }

  private snapshotCurrentTree(db: Database, message: string): CommitRow {
    const head = this.ensureHeadCommit(db);
    const activeConcepts = getActiveConcepts(db);
    const treeEntries = activeConcepts
      .filter((c) => c.active_chunk_id)
      .map((c) => ({ conceptId: c.id, chunkId: c.active_chunk_id!, conceptName: c.name }));
    const commit = insertCommit(db, null, head.id, null, message);
    insertCommitTree(db, commit.id, treeEntries);
    return commit;
  }

  private updateManifestForLifecycle(db: Database, debtBefore: number): { debtAfter: number } {
    const manifest = getManifest(db);
    const fiedlerValue = manifest?.fiedler_value ?? 0;
    const concepts = getActiveConcepts(db);
    const debtAfter = computeTotalDebt(concepts, fiedlerValue);
    upsertManifest(db, {
      chunk_count: getChunkCount(db),
      concept_count: getActiveConceptCount(db),
      debt: debtAfter,
      debt_trend: computeDebtTrend(debtAfter, debtBefore),
      last_integrated: new Date().toISOString(),
    });
    return { debtAfter };
  }

  private async updateActiveChunkMetadata(
    db: Database,
    concept: ConceptRow,
    updates: Record<string, unknown>,
  ): Promise<void> {
    if (!concept.active_chunk_id) return;
    const chunk = getChunk(db, concept.active_chunk_id);
    if (!chunk) return;
    await updateChunkFrontmatter(chunk.file_path, updates);
  }

  private async readConceptContent(db: Database, concept: ConceptRow): Promise<string> {
    if (!concept.active_chunk_id) return "";
    const chunk = getChunk(db, concept.active_chunk_id);
    if (!chunk) return "";
    const parsed = await readChunk(chunk.file_path);
    return parsed.content;
  }

  private async appendStateChunkForConcept(
    db: Database,
    lorePath: string,
    concept: ConceptRow,
    content: string,
    narrativeOrigin: string,
    embedder: Embedder,
    embeddingModel: string,
    opts?: { supersedesId?: string | null },
  ): Promise<{ chunkId: string; residual: number }> {
    const supersedesId =
      opts?.supersedesId !== undefined ? opts.supersedesId : concept.active_chunk_id;

    let nextVersion = 1;
    if (supersedesId) {
      const currentChunk = getChunk(db, supersedesId);
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
      concept: concept.name,
      conceptId: concept.id,
      narrativeOrigin,
      version: nextVersion,
      supersedes: supersedesId ?? null,
      content,
    });

    if (supersedesId) {
      const oldChunk = getChunk(db, supersedesId);
      if (oldChunk) {
        await markSuperseded(oldChunk.file_path, id);
      }
    }

    insertChunk(db, {
      id,
      filePath,
      flType: "chunk",
      conceptId: concept.id,
      narrativeId: null,
      supersedesId: supersedesId ?? null,
      createdAt: new Date().toISOString(),
    });
    insertFtsContent(db, content, id);

    const embedding = await embedder.embed(content);
    insertEmbedding(db, id, embedding, embeddingModel);
    await writeEmbeddingFile(embeddingFilePath(filePath), embeddingModel, embedding);

    const embeddedAt = new Date().toISOString();
    let residual = 0;
    if (supersedesId) {
      const oldEmb = getEmbeddingForChunk(db, supersedesId);
      if (oldEmb) {
        const oldVec = new Float32Array(oldEmb.embedding.buffer);
        residual = cosineDistance(oldVec, embedding);
      }
    }

    await updateChunkFrontmatter(filePath, {
      fl_embedding_model: embeddingModel,
      fl_embedded_at: embeddedAt,
      fl_residual: residual,
      fl_staleness: 0,
      fl_lifecycle_status: "active",
      fl_archived_at: null,
      fl_lifecycle_reason: null,
      fl_merged_into_concept_id: null,
    });

    insertConceptVersion(db, concept.id, {
      active_chunk_id: id,
      residual,
      staleness: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
    });

    return { chunkId: id, residual };
  }

  async conceptRename(
    from: string,
    to: string,
    opts?: { codePath?: string },
  ): Promise<LifecycleResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = this.resolveConceptByNameCi(db, from, { activeOnly: true });
    this.assertConceptNameAvailable(db, to, { excludeId: concept.id });
    const debtBefore = getManifest(db)?.debt ?? 0;

    insertConceptVersion(db, concept.id, { name: to });
    await this.updateActiveChunkMetadata(db, concept, { fl_concept: to });

    const commit = this.snapshotCurrentTree(db, `lifecycle: rename ${concept.name} -> ${to}`);
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "rename",
      commit_id: commit.id,
      summary: `Renamed concept '${concept.name}' to '${to}'.`,
      affected: [concept.name, to],
    };
  }

  async conceptArchive(
    name: string,
    opts?: { codePath?: string; reason?: string },
  ): Promise<LifecycleResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = this.resolveConceptByNameCi(db, name, { activeOnly: true });
    const debtBefore = getManifest(db)?.debt ?? 0;
    const now = new Date().toISOString();

    insertConceptVersion(db, concept.id, {
      active_chunk_id: null,
      lifecycle_status: "archived",
      archived_at: now,
      lifecycle_reason: opts?.reason ?? "archived",
      merged_into_concept_id: null,
    });
    await this.updateActiveChunkMetadata(db, concept, {
      fl_lifecycle_status: "archived",
      fl_archived_at: now,
      fl_lifecycle_reason: opts?.reason ?? "archived",
      fl_merged_into_concept_id: null,
    });

    const commit = this.snapshotCurrentTree(db, `lifecycle: archive ${concept.name}`);
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "archive",
      commit_id: commit.id,
      summary: `Archived concept '${concept.name}'.`,
      affected: [concept.name],
    };
  }

  async conceptRestore(name: string, opts?: { codePath?: string }): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const concept = this.resolveConceptByNameCi(db, name);
    if (this.isActiveConcept(concept)) {
      throw new LoreError("CONCEPT_INVALID_STATE", `Concept '${concept.name}' is already active`);
    }
    this.assertConceptNameAvailable(db, concept.name, { excludeId: concept.id });
    const debtBefore = getManifest(db)?.debt ?? 0;

    const latestChunk = db
      .query<{ id: string }, [string]>(
        `SELECT id FROM chunks
         WHERE concept_id = ? AND fl_type = 'chunk'
         ORDER BY created_at DESC LIMIT 1`,
      )
      .get(concept.id);
    if (!latestChunk?.id) {
      throw new LoreError(
        "CONCEPT_INVALID_STATE",
        `Concept '${concept.name}' has no state chunks to restore`,
      );
    }

    insertConceptVersion(db, concept.id, {
      active_chunk_id: latestChunk.id,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
    });

    const restoredChunk = getChunk(db, latestChunk.id);
    if (restoredChunk) {
      await updateChunkFrontmatter(restoredChunk.file_path, {
        fl_lifecycle_status: "active",
        fl_archived_at: null,
        fl_lifecycle_reason: null,
        fl_merged_into_concept_id: null,
      });
    }

    const config = this.configFor(entry);
    await discoverConcepts(db, await this.generatorFor(config, this.loreNameFor(entry)));
    const commit = this.snapshotCurrentTree(db, `lifecycle: restore ${concept.name}`);
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "restore",
      commit_id: commit.id,
      summary: `Restored concept '${concept.name}'.`,
      affected: [concept.name],
    };
  }

  async conceptMerge(
    sourceName: string,
    targetName: string,
    opts?: { codePath?: string; reason?: string; preview?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const source = this.resolveConceptByNameCi(db, sourceName, { activeOnly: true });
    const target = this.resolveConceptByNameCi(db, targetName, { activeOnly: true });
    if (source.id === target.id) {
      throw new LoreError("CONCEPT_INVALID_STATE", "Source and target must be different concepts");
    }

    const config = this.configFor(entry);
    const generator = await this.generatorFor(config, this.loreNameFor(entry));
    const sourceContent = await this.readConceptContent(db, source);
    const targetContent = await this.readConceptContent(db, target);
    const mergedContent = await generator.generateIntegration(
      [`Merge findings from concept "${source.name}" into "${target.name}".\n\n${sourceContent}`],
      targetContent ? [targetContent] : [],
      target.name,
    );

    if (opts?.preview) {
      return {
        action: "merge",
        commit_id: null,
        preview: true,
        summary: `Preview merge '${source.name}' -> '${target.name}'.`,
        affected: [source.name, target.name],
        proposal: {
          source: source.name,
          target: target.name,
          merged_content: mergedContent,
        },
      };
    }

    const debtBefore = getManifest(db)?.debt ?? 0;
    await this.appendStateChunkForConcept(
      db,
      entry.lore_path,
      target,
      mergedContent,
      `lifecycle-merge:${source.name}`,
      await this.embedderFor(config, this.loreNameFor(entry)),
      config.ai.embedding.model,
      { supersedesId: target.active_chunk_id },
    );

    const now = new Date().toISOString();
    insertConceptVersion(db, source.id, {
      active_chunk_id: null,
      lifecycle_status: "merged",
      archived_at: now,
      lifecycle_reason: opts?.reason ?? `merged into ${target.name}`,
      merged_into_concept_id: target.id,
    });
    await this.updateActiveChunkMetadata(db, source, {
      fl_lifecycle_status: "merged",
      fl_archived_at: now,
      fl_lifecycle_reason: opts?.reason ?? `merged into ${target.name}`,
      fl_merged_into_concept_id: target.id,
    });

    await discoverConcepts(db, generator);
    const commit = this.snapshotCurrentTree(
      db,
      `lifecycle: merge ${source.name} -> ${target.name}`,
    );
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "merge",
      commit_id: commit.id,
      summary: `Merged '${source.name}' into '${target.name}'.`,
      affected: [source.name, target.name],
    };
  }

  async conceptSplit(
    name: string,
    opts?: { codePath?: string; parts?: number; preview?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const source = this.resolveConceptByNameCi(db, name, { activeOnly: true });
    const parts = Math.max(2, opts?.parts ?? 2);
    const config = this.configFor(entry);
    const generator = await this.generatorFor(config, this.loreNameFor(entry));
    const sourceContent = await this.readConceptContent(db, source);
    const proposals = await generator.proposeSplit(source.name, sourceContent, parts);

    const uniqueProposalNames = new Set<string>();
    for (const proposal of proposals) {
      if (uniqueProposalNames.has(proposal.name.toLowerCase())) {
        throw new LoreError(
          "CONCEPT_NAME_CONFLICT",
          `Split generated duplicate concept name '${proposal.name}'`,
        );
      }
      uniqueProposalNames.add(proposal.name.toLowerCase());
      this.assertConceptNameAvailable(db, proposal.name);
    }

    if (opts?.preview) {
      return {
        action: "split",
        commit_id: null,
        preview: true,
        summary: `Preview split '${source.name}' into ${proposals.length} concepts.`,
        affected: [source.name],
        proposal: {
          source: source.name,
          splits: proposals,
        },
      };
    }

    const debtBefore = getManifest(db)?.debt ?? 0;
    const embedder = await this.embedderFor(config, this.loreNameFor(entry));
    const created: string[] = [];
    for (const proposal of proposals) {
      const concept = insertConcept(db, proposal.name);
      await this.appendStateChunkForConcept(
        db,
        entry.lore_path,
        concept,
        proposal.content,
        `lifecycle-split:${source.name}`,
        embedder,
        config.ai.embedding.model,
        { supersedesId: null },
      );
      created.push(proposal.name);
    }

    const now = new Date().toISOString();
    insertConceptVersion(db, source.id, {
      active_chunk_id: null,
      lifecycle_status: "archived",
      archived_at: now,
      lifecycle_reason: `split into ${created.join(", ")}`,
      merged_into_concept_id: null,
    });
    await this.updateActiveChunkMetadata(db, source, {
      fl_lifecycle_status: "archived",
      fl_archived_at: now,
      fl_lifecycle_reason: `split into ${created.join(", ")}`,
      fl_merged_into_concept_id: null,
    });

    await discoverConcepts(db, generator);
    const commit = this.snapshotCurrentTree(
      db,
      `lifecycle: split ${source.name} -> ${created.length} concepts`,
    );
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "split",
      commit_id: commit.id,
      summary: `Split '${source.name}' into ${created.length} concepts.`,
      affected: [source.name, ...created],
    };
  }

  async conceptPatch(
    name: string,
    text: string,
    opts?: { codePath?: string; topics?: string[]; direct?: boolean },
  ): Promise<LifecycleResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const concept = this.resolveConceptByNameCi(db, name, { activeOnly: true });
    const config = this.configFor(entry);

    const generator = await this.generatorFor(config, this.loreNameFor(entry));
    const currentContent = await this.readConceptContent(db, concept);

    let newContent: string;
    if (opts?.direct) {
      newContent = text.trim();
    } else {
      const topicsSuffix =
        opts?.topics && opts.topics.length > 0
          ? `\n\nRelated topics: ${opts.topics.join(", ")}`
          : "";
      newContent = await generator.generateIntegration(
        [text + topicsSuffix],
        currentContent ? [currentContent] : [],
        concept.name,
      );
    }

    if (newContent.trim() === currentContent.trim()) {
      return {
        action: "patch",
        commit_id: null,
        summary: `No patch changes produced for '${concept.name}'.`,
        affected: [concept.name],
      };
    }

    const debtBefore = getManifest(db)?.debt ?? 0;
    await this.appendStateChunkForConcept(
      db,
      entry.lore_path,
      concept,
      newContent,
      `lifecycle-patch:${concept.name}`,
      await this.embedderFor(config, this.loreNameFor(entry)),
      config.ai.embedding.model,
      { supersedesId: concept.active_chunk_id },
    );

    await discoverConcepts(db, generator);
    const commit = this.snapshotCurrentTree(db, `lifecycle: patch ${concept.name}`);
    this.updateManifestForLifecycle(db, debtBefore);

    return {
      action: "patch",
      commit_id: commit.id,
      summary: `Patched concept '${concept.name}'.`,
      affected: [concept.name],
    };
  }

  setConceptRelation(
    fromConceptName: string,
    toConceptName: string,
    relationType: RelationType,
    opts?: { codePath?: string; weight?: number },
  ): ConceptRelationSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const from = this.resolveConceptByNameCi(db, fromConceptName, { activeOnly: true });
    const to = this.resolveConceptByNameCi(db, toConceptName, { activeOnly: true });
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
    const from = this.resolveConceptByNameCi(db, fromConceptName, { activeOnly: true });
    const to = this.resolveConceptByNameCi(db, toConceptName, { activeOnly: true });
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
      ? this.resolveConceptByNameCi(db, opts.concept, { activeOnly: false }).id
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
    const concept = this.resolveConceptByNameCi(db, conceptName, { activeOnly: true });
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
    const concept = this.resolveConceptByNameCi(db, conceptName, { activeOnly: false });
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
      ? this.resolveConceptByNameCi(db, opts.concept, { activeOnly: false }).id
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

  async computeConceptHealth(opts?: {
    codePath?: string;
    top?: number;
  }): Promise<ConceptHealthComputeResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const concepts = getActiveConcepts(db);
    const manifest = getManifest(db);
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest);
    return this.persistConceptHealthRun(db, concepts, manifest, debtSnapshot, { top: opts?.top });
  }

  async explainConceptHealth(
    conceptName: string,
    opts?: { codePath?: string; neighborLimit?: number; recompute?: boolean },
  ): Promise<ConceptHealthExplainResult> {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const concept = this.resolveConceptByNameCi(db, conceptName, { activeOnly: true });
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
    stopLossDelta?: number;
    leaseTtlMs?: number;
    maxRetries?: number;
    runId?: string;
  }): Promise<HealConceptsResult> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const dry = opts?.dry ?? false;
    const threshold = Math.max(0, Math.min(1, opts?.threshold ?? 0.6));
    const limit = Math.max(1, opts?.limit ?? 5);
    const workers = Math.max(1, Math.floor(opts?.workers ?? 4));
    const batchSize = Math.max(1, Math.floor(opts?.batchSize ?? 5));
    const stopLossDelta =
      opts?.stopLossDelta !== undefined && Number.isFinite(opts.stopLossDelta)
        ? Math.max(0, opts.stopLossDelta)
        : 0.1;
    const leaseTtlMs =
      opts?.leaseTtlMs !== undefined && Number.isFinite(opts.leaseTtlMs)
        ? Math.max(1_000, Math.floor(opts.leaseTtlMs))
        : 30_000;
    const maxRetries =
      opts?.maxRetries !== undefined && Number.isFinite(opts.maxRetries)
        ? Math.max(0, Math.floor(opts.maxRetries))
        : 0;
    const runId = opts?.runId?.trim() ? opts.runId.trim() : `heal-${ulid()}`;

    await this.computeConceptHealth({ codePath: opts?.codePath });
    const activeConceptById = new Map(
      getActiveConcepts(db).map((concept) => [concept.id, concept]),
    );
    const signals = getCurrentConceptHealthSignals(db)
      .filter((signal) => signal.final_stale >= threshold)
      .sort((a, b) => b.final_stale - a.final_stale)
      .slice(0, limit);
    const signalByConceptId = new Map(
      signals.map((signal) => [signal.concept_id, signal.final_stale]),
    );
    type ClaimedLease = NonNullable<ReturnType<typeof claimConceptHealLease>>;

    const healed: HealConceptsResult["healed"] = [];
    const manifest = getManifest(db);
    const fiedlerValue = manifest?.fiedler_value ?? 0;
    const preDebt = computeTotalDebt(getActiveConcepts(db), fiedlerValue);
    let postDebt = preDebt;
    let retried = 0;
    let batchesProcessed = 0;
    let haltedAtBatch: number | null = null;
    let partial = false;
    let haltReason: string | undefined;

    if (signals.length === 0) {
      return {
        run_id: runId,
        dry,
        considered: 0,
        healed: [],
        worker_stats: {
          configured: workers,
          completed: 0,
          failed: 0,
          retried: 0,
        },
        batch_stats: {
          processed: 0,
          halted_at_batch: null,
          pre_debt: preDebt,
          post_debt: postDebt,
        },
      };
    }

    if (dry) {
      for (const signal of signals) {
        const concept = activeConceptById.get(signal.concept_id);
        if (!concept) continue;
        const heal = healSignal({ concept, finalStale: signal.final_stale });
        healed.push({
          concept: concept.name,
          from_staleness: heal.from_staleness,
          to_staleness: heal.to_staleness,
          from_residual: heal.from_residual,
          to_residual: heal.to_residual,
        });
      }
    } else {
      queueConceptHealLeases(db, {
        lorePath: entry.lore_path,
        runId,
        conceptIds: signals.map((signal) => signal.concept_id),
      });

      const processLease = async (lease: ClaimedLease): Promise<void> => {
        const owner = lease.owner ?? "worker";
        const finalStale = signalByConceptId.get(lease.concept_id);
        if (finalStale === undefined) {
          skipConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
            reason: "missing health signal for concept",
          });
          return;
        }

        const concept = getConcept(db, lease.concept_id);
        if (!concept || !this.isActiveConcept(concept)) {
          skipConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
            reason: "concept is no longer active",
          });
          return;
        }

        const heal = healSignal({ concept, finalStale });
        let mutated = false;

        try {
          insertConceptVersion(db, concept.id, {
            staleness: heal.to_staleness,
            residual: heal.to_residual,
          });
          mutated = true;

          await this.updateActiveChunkMetadata(db, concept, {
            fl_staleness: heal.to_staleness,
            fl_residual: heal.to_residual,
          });

          completeConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
          });

          healed.push({
            concept: concept.name,
            from_staleness: heal.from_staleness,
            to_staleness: heal.to_staleness,
            from_residual: heal.from_residual,
            to_residual: heal.to_residual,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const fail = failConceptHealLease(db, {
            lorePath: entry.lore_path,
            runId,
            conceptId: lease.concept_id,
            owner,
            error: message,
            retry: !mutated,
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

        postDebt = computeTotalDebt(getActiveConcepts(db), fiedlerValue);
        if (postDebt > preDebt + stopLossDelta) {
          partial = true;
          haltedAtBatch = batchesProcessed;
          haltReason =
            `stop-loss triggered after batch ${batchesProcessed}: ` +
            `debt increased ${(postDebt - preDebt).toFixed(3)} ` +
            `(threshold ${stopLossDelta.toFixed(3)})`;
          break;
        }
      }

      postDebt = computeTotalDebt(getActiveConcepts(db), fiedlerValue);
      upsertManifest(db, {
        debt: postDebt,
        debt_trend: computeDebtTrend(postDebt, preDebt),
      });
      await this.computeConceptHealth({ codePath: opts?.codePath });
    }

    const leaseCounts = dry
      ? null
      : getConceptHealLeaseStatusCounts(db, {
          lorePath: entry.lore_path,
          runId,
        });

    const result: HealConceptsResult = {
      run_id: runId,
      dry,
      considered: signals.length,
      healed,
      worker_stats: {
        configured: workers,
        completed: dry ? healed.length : (leaseCounts?.done ?? 0),
        failed: dry ? 0 : (leaseCounts?.failed ?? 0),
        retried,
      },
      batch_stats: {
        processed: dry
          ? signals.length === 0
            ? 0
            : Math.ceil(signals.length / batchSize)
          : batchesProcessed,
        halted_at_batch: haltedAtBatch,
        pre_debt: preDebt,
        post_debt: postDebt,
      },
    };

    if (partial) result.partial = true;
    if (haltReason) result.halt_reason = haltReason;

    return result;
  }

  // ─── CLI-Only Operations ──────────────────────────────

  async ls(opts?: { codePath?: string }) {
    const { name, entry, db } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db);
    const config = this.configFor(entry);
    const concepts = getActiveConcepts(db);
    const manifest = getManifest(db);
    const openNarratives = getOpenNarratives(db);
    const debtSnapshot = await computeDebtSnapshot(entry, db, concepts, manifest);
    const conceptsWithLiveStaleness = concepts.map((concept) => ({
      ...concept,
      staleness: conceptLiveStaleness(concept, debtSnapshot.refDriftScoreByConcept),
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

  async show(conceptName: string, opts?: { codePath?: string; ref?: string }) {
    const { db } = this.resolveLoreMind(opts?.codePath);

    // Historical ref: resolve commit and look up concept in that tree
    if (opts?.ref) {
      return this.showAtCommit(db, opts.ref, conceptName);
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
    if (!chunkId) return { concept, content: null };
    const chunkRow = getChunk(db, chunkId);
    if (!chunkRow) return { concept, content: null };
    const parsed = await readChunk(chunkRow.file_path);
    return { concept, content: parsed.content };
  }

  async showNarrativeTrail(
    narrativeName: string,
    opts?: { codePath?: string },
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
    return {
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
    return rebuildFromDisk(db, entry.lore_path, config);
  }

  async reEmbed(opts?: {
    codePath?: string;
    onProgress?: (phase: "text" | "code" | "graph", current: number, total: number, model?: string) => void;
  }): Promise<{ reEmbedded: number; codeEmbedded: number; deleted: number; textModel: string; codeModel: string | null }> {
    const { entry, db } = this.resolveLoreMind(opts?.codePath);
    const config = this.configFor(entry);
    const embedder = await this.embedderFor(config, this.loreNameFor(entry));

    const { deleteAllEmbeddings: deleteAllEmb } = await import("@/db/embeddings.ts");
    const {
      embeddingFilePath: embPath,
      writeEmbeddingFile: writeEmb,
      deleteEmbeddingFile: deleteEmb,
    } = await import("@/storage/embedding-io.ts");
    const { readChunk: readChunkFn } = await import("@/storage/chunk-reader.ts");
    const { insertEmbedding: insertEmb } = await import("@/db/embeddings.ts");

    const textModel = config.ai.embedding.model;
    const codeEmbedder = await this.codeEmbedderFor(config, this.loreNameFor(entry));
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

    // 4. Pre-read all contents concurrently
    const EMBED_BATCH_SIZE = 96;
    const [proseContents, sourceContents] = await Promise.all([
      Promise.all(proseChunks.map((c) => readChunkFn(c.file_path).then((p) => p.content))),
      Promise.all(sourceChunks.map((c) => readChunkFn(c.file_path).then((p) => p.content))),
    ]);

    // 5. Run text and code embedding passes concurrently
    // Both passes call different remote APIs; DB writes are serialized by the event loop.
    let reEmbedded = 0;
    let codeEmbedded = 0;

    const textPass = async () => {
      for (let i = 0; i < proseChunks.length; i += EMBED_BATCH_SIZE) {
        const batchChunks = proseChunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchContents = proseContents.slice(i, i + EMBED_BATCH_SIZE);
        const batchEmbeddings = await embedder.embedBatch(batchContents);
        for (let j = 0; j < batchChunks.length; j++) {
          const chunk = batchChunks[j]!;
          const embedding = batchEmbeddings[j]!;
          insertEmb(db, chunk.id, embedding, textModel);
          await writeEmb(embPath(chunk.file_path), textModel, embedding);
          reEmbedded++;
          opts?.onProgress?.("text", reEmbedded, proseChunks.length, textModel);
        }
      }
    };

    const codePass = async () => {
      if (!codeEmbedder || !resolvedCodeModel) return;

      const { insertSymbolEmbedding, deleteAllSymbolEmbeddings } = await import("@/db/embeddings.ts");
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
          const content = await readSymbolContent(entry.code_path, sym.file_path, sym.line_start, sym.line_end);
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
      for (let i = 0; i < sourceChunks.length; i += EMBED_BATCH_SIZE) {
        const batchChunks = sourceChunks.slice(i, i + EMBED_BATCH_SIZE);
        const batchContents = sourceContents.slice(i, i + EMBED_BATCH_SIZE);
        try {
          const batchEmbeddings = await codeEmbedder.embedBatch(batchContents);
          for (let j = 0; j < batchChunks.length; j++) {
            insertEmb(db, batchChunks[j]!.id, batchEmbeddings[j]!, resolvedCodeModel);
            codeEmbedded++;
            opts?.onProgress?.("code", codeEmbedded, sourceChunks.length, resolvedCodeModel);
          }
        } catch (err) {
          throw new Error(
            `Code embedding failed on batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1} (source chunks ${i + 1}-${Math.min(i + EMBED_BATCH_SIZE, sourceChunks.length)}/${sourceChunks.length}): ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };

    await Promise.all([textPass(), codePass()]);

    // 6. Recompute edges if we have enough state chunk embeddings
    if (reEmbedded >= 2) {
      opts?.onProgress?.("graph", 0, 1);
      const { discoverConcepts: discover } = await import("./concept-discovery.ts");
      const generator = await this.generatorFor(config, this.loreNameFor(entry));
      await discover(db, generator);
      opts?.onProgress?.("graph", 1, 1);
    }

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

  async healthCheck(_opts?: { codePath?: string }) {
    const config = this.configFor();
    const embedder = await this.embedderFor(config);

    // Check each registered lore mind
    const lore_minds = listLoreMinds(this.registry);
    const loreMindReports = lore_minds.map((loreMind) => {
      const db = this.dbFor(loreMind.lore_path);
      const manifest = getManifest(db);
      const openNarrativesList = getOpenNarratives(db);
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
    let diff_from_current: {
      hunks: DiffHunk[];
      adds: number;
      removes: number;
    } | undefined;
    if (historicalContent) {
      try {
        const currentChunkId = concept.active_chunk_id;
        if (currentChunkId && currentChunkId !== chunkId) {
          const currentChunkRow = getChunk(db, currentChunkId);
          if (currentChunkRow) {
            const currentParsed = await readChunk(currentChunkRow.file_path);
            if (currentParsed.content && !isDiffTooLarge(historicalContent, currentParsed.content)) {
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
    const { getOpenNarrativeByName } = await import("@/db/index.ts");
    const narrative = getOpenNarrativeByName(db, narrativeName);
    if (!narrative) {
      throw new LoreError("NO_ACTIVE_NARRATIVE", `No open narrative named '${narrativeName}'`);
    }
    const plan = await analyzeJournal(
      db,
      narrative.id,
      await this.generatorFor(config, this.loreNameFor(entry)),
      await this.embedderFor(config, this.loreNameFor(entry)),
      config,
    );
    return { narrative, plan };
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
    return { config: Object.keys(config).length > 0 ? config : undefined, resolved: this.configFor(entry) };
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
    kind?: import("@/types/index.ts").SuggestionKind | import("@/types/index.ts").SuggestionKind[];
  }): Promise<SuggestResult> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    this.ensureGraphFresh(db);
    const config = this.configFor(entry);
    let generator: import("./generator.ts").Generator | undefined;
    try {
      generator = await this.generatorFor(config, this.loreNameFor(entry));
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
    const { resolve } = await import("path");
    const abs = resolve(filePath);
    const result = await ingestDocFile(db, entry.code_path, entry.lore_path, abs);
    return {
      files_ingested: result === "ingested" ? 1 : 0,
      files_skipped: result === "skipped" ? 1 : 0,
      files_removed: 0,
      duration_ms: 0,
    };
  }

  async ingestAll(opts?: { codePath?: string }): Promise<{ scan: ScanResult; ingest: IngestResult }> {
    const { db, entry } = this.resolveLoreMind(opts?.codePath);
    const [scan, ingest] = await Promise.all([
      rescanProject(db, entry.code_path, entry.lore_path),
      ingestTextFiles(db, entry.code_path, entry.lore_path),
    ]);
    return { scan, ingest };
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
    const row = this.resolveConceptByNameCi(db, concept, { activeOnly: true });
    return getBindingSummariesForConcept(db, row.id);
  }

  bindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string; confidence?: number },
  ): ConceptBindingSummary {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptRow = this.resolveConceptByNameCi(db, concept, { activeOnly: true });
    const symbolRow = getSymbolByQualifiedName(db, symbolQualifiedName);
    if (!symbolRow) {
      throw new LoreError(
        "CONCEPT_NOT_FOUND",
        `No symbol with qualified name '${symbolQualifiedName}'`,
      );
    }
    upsertConceptSymbol(db, {
      conceptId: conceptRow.id,
      symbolId: symbolRow.id,
      bindingType: "ref",
      boundBodyHash: symbolRow.body_hash,
      confidence: opts?.confidence ?? 1.0,
    });
    const summaries = getBindingSummariesForConcept(db, conceptRow.id);
    const match = summaries.find((s) => s.symbol_qualified_name === symbolQualifiedName);
    return match!;
  }

  unbindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string },
  ): { removed: boolean } {
    const { db } = this.resolveLoreMind(opts?.codePath);
    const conceptRow = this.resolveConceptByNameCi(db, concept, { activeOnly: true });
    const symbolRow = getSymbolByQualifiedName(db, symbolQualifiedName);
    if (!symbolRow) {
      return { removed: false };
    }
    const removed = deleteConceptSymbol(db, conceptRow.id, symbolRow.id);
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
