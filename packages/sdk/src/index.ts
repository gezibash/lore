import {
  LoreEngine,
  LoreError,
  getDeepValue,
  GENERATION_PROMPT_KEYS as CORE_GENERATION_PROMPT_KEYS,
  normalizePromptKey as coreNormalizePromptKey,
  describeSchemaIssue as coreDescribeSchemaIssue,
  timeAgo,
  formatClose as coreFormatClose,
  formatHistory as coreFormatHistory,
  formatLifecycleResult as coreFormatLifecycleResult,
  formatLog as coreFormatLog,
  formatLs as coreFormatLs,
  formatOpen as coreFormatOpen,
  formatQuery as coreFormatQuery,
  formatShow as coreFormatShow,
  formatStatus as coreFormatStatus,
  formatSuggest as coreFormatSuggest,
  formatBindings as coreFormatBindings,
  formatDryRunClose as coreFormatDryRunClose,
  formatNarrativeTrail as coreFormatNarrativeTrail,
  formatTreeDiff as coreFormatTreeDiff,
  type TreeDiffFormatOptions,
  formatCommitLog as coreFormatCommitLog,
  formatBootstrapPlan as coreFormatBootstrapPlan,
  type DryRunCloseFormatInput,
  computeLineDiff as coreComputeLineDiff,
  isDiffTooLarge as coreIsDiffTooLarge,
  type DiffHunk,
  type DiffLine,
} from "@lore/core";
import type {
  AutoBindResult,
  BootstrapPlan,
  CloseMode,
  CloseJob,
  CloseJobDetail,
  CloseResult,
  CloseWorkerRunResult,
  CommitLogEntry,
  CoverageReport,
  IngestResult,
  MergeStrategy,
  NarrativeTarget,
  NarrativeTrailResult,
  DryRunCloseResult,
  ExecutiveSummary,
  FileRef,
  GenerationPromptKey,
  LoreConfig,
  LoreHealthSnapshot,
  HistoryResult,
  JournalDesignationResult,
  LifecycleResult,
  LogResult,
  LsResult,
  MigrationStatus,
  OpenResult,
  ConceptHealthComputeResult,
  ConceptHealthExplainResult,
  ConceptRelationSummary,
  ConceptTagSummary,
  HealConceptsResult,
  RelationType,
  OrchestrationQueryOptions,
  PromptPreviewResult,
  ProviderCredential,
  QueryOptions,
  QueryResult,
  RecallResult,
  RecallSection,
  RegisterResult,
  RegistryEntry,
  LoreMindConfigCloneResult,
  LoreMindConfigResult,
  ResolveDangling,
  RebuildResult,
  ScanResult,
  ScanStats,
  SymbolKind,
  SymbolRow,
  SymbolSearchResult,
  ConceptBindingSummary,
  SymbolDriftResult,
  SchemaIssue,
  SchemaRepairOptions,
  SchemaRepairResult,
  SharedProvider,
  ShowResult,
  StatusResult,
  SuggestionKind,
  SuggestResult,
  TreeDiff,
  WebSearchResult,
} from "./types.ts";

export type * from "./types.ts";
export type { DiffHunk, DiffLine } from "@lore/core";
export { LoreError, getDeepValue, timeAgo };
export {
  renderNarrativeWithCitations,
  renderProvenance,
  renderExecutiveSummary,
} from "./format-helpers.ts";

export const GENERATION_PROMPT_KEYS = CORE_GENERATION_PROMPT_KEYS;

export function normalizePromptKey(value: string): GenerationPromptKey | null {
  return coreNormalizePromptKey(value) as GenerationPromptKey | null;
}

export function describeSchemaIssue(issue: SchemaIssue): string {
  return coreDescribeSchemaIssue(issue);
}

export function formatOpen(result: OpenResult): string {
  return coreFormatOpen(result);
}

export function formatLog(result: LogResult): string {
  return coreFormatLog(result);
}

export function formatQuery(result: QueryResult): string {
  return coreFormatQuery(result);
}

export function formatClose(result: CloseResult): string {
  return coreFormatClose(result);
}

export function formatStatus(result: StatusResult): string {
  return coreFormatStatus(result);
}

export function formatLs(result: LsResult): string {
  return coreFormatLs(result);
}

export function formatShow(conceptName: string, result: ShowResult): string {
  return coreFormatShow(conceptName, result);
}

export function formatHistory(conceptName: string, result: HistoryResult): string {
  return coreFormatHistory(conceptName, result);
}

export function formatLifecycleResult(result: LifecycleResult): string {
  return coreFormatLifecycleResult(result);
}

export function formatSuggest(result: SuggestResult): string {
  return coreFormatSuggest(result);
}

export function formatBindings(bindings: ConceptBindingSummary[]): string {
  return coreFormatBindings(bindings);
}

export function formatDryRunClose(result: DryRunCloseFormatInput): string {
  return coreFormatDryRunClose(result);
}

export function formatTreeDiff(diff: TreeDiff, opts?: TreeDiffFormatOptions): string {
  return coreFormatTreeDiff(diff, opts);
}

export type { TreeDiffFormatOptions };

export function formatCommitLog(entries: CommitLogEntry[]): string {
  return coreFormatCommitLog(entries);
}

export function formatNarrativeTrail(result: NarrativeTrailResult): string {
  return coreFormatNarrativeTrail(result);
}

export function formatBootstrapPlan(plan: BootstrapPlan): string {
  return coreFormatBootstrapPlan(plan);
}

export function computeLineDiff(
  oldText: string,
  newText: string,
  contextLines?: number,
): DiffHunk[] {
  return coreComputeLineDiff(oldText, newText, contextLines);
}

export function isDiffTooLarge(oldText: string, newText: string): boolean {
  return coreIsDiffTooLarge(oldText, newText);
}

interface LoreClientEngine {
  shutdown(): void;
  register(codePath: string, name?: string): Promise<RegisterResult>;
  open(
    narrative: string,
    intent: string,
    opts?: {
      codePath?: string;
      resolveDangling?: ResolveDangling;
      targets?: NarrativeTarget[];
      fromResultId?: string;
    },
  ): Promise<OpenResult>;
  log(
    narrative: string,
    entry: string,
    opts: {
      topics?: string[];
      codePath?: string;
      refs?: FileRef[];
      concepts: string[];
      symbols?: string[];
    },
  ): Promise<LogResult>;
  designateJournalEntry(
    narrative: string,
    chunkId: string,
    opts: { concepts?: string[]; codePath?: string },
  ): Promise<JournalDesignationResult>;
  query(query: string, opts?: QueryOptions): Promise<QueryResult>;
  queryForOrchestration(query: string, opts?: OrchestrationQueryOptions): Promise<QueryResult>;
  searchWeb(query: string, opts?: { codePath?: string }): Promise<WebSearchResult[]>;
  summarizeMatches(
    query: string,
    matches: Array<{ concept: string; score: number; content: string; lore_mind?: string }>,
    opts?: {
      codePath?: string;
      timeoutMs?: number;
      systemPrompt?: string;
    },
  ): Promise<ExecutiveSummary | undefined>;
  close(
    narrative: string,
    opts?: {
      codePath?: string;
      mode?: CloseMode;
      mergeStrategy?: MergeStrategy;
      fromResultId?: string;
      wait?: boolean;
      pollMs?: number;
    },
  ): Promise<CloseResult>;
  listCloseJobs(opts?: { codePath?: string; limit?: number }): Promise<CloseJob[]>;
  getCloseJobDetail(jobId: string, opts?: { codePath?: string }): Promise<CloseJobDetail>;
  waitForCloseJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<CloseResult>;
  runCloseWorker(opts?: {
    codePath?: string;
    watch?: boolean;
    pollMs?: number;
  }): Promise<CloseWorkerRunResult>;
  status(opts?: { codePath?: string }): Promise<StatusResult>;
  healthSnapshot(opts?: { codePath?: string }): LoreHealthSnapshot;
  ls(opts?: { codePath?: string }): Promise<LsResult>;
  show(
    concept: string,
    opts?: { codePath?: string; ref?: string; fromResultId?: string },
  ): Promise<ShowResult>;
  history(concept: string, opts?: { codePath?: string }): Promise<HistoryResult>;
  showNarrativeTrail(
    narrativeName: string,
    opts?: { codePath?: string; fromResultId?: string },
  ): Promise<NarrativeTrailResult>;
  diffCommits(
    fromRef: string,
    toRef: string,
    opts?: { codePath?: string; includeContent?: boolean },
  ): Promise<TreeDiff>;
  conceptRename(from: string, to: string, opts?: { codePath?: string }): Promise<LifecycleResult>;
  conceptArchive(
    concept: string,
    opts?: { codePath?: string; reason?: string },
  ): Promise<LifecycleResult>;
  conceptRestore(concept: string, opts?: { codePath?: string }): Promise<LifecycleResult>;
  conceptMerge(
    source: string,
    target: string,
    opts?: { codePath?: string; reason?: string; preview?: boolean },
  ): Promise<LifecycleResult>;
  conceptSplit(
    concept: string,
    opts?: { codePath?: string; parts?: number; preview?: boolean },
  ): Promise<LifecycleResult>;
  conceptPatch(
    concept: string,
    text: string,
    opts?: { codePath?: string; topics?: string[]; direct?: boolean },
  ): Promise<LifecycleResult>;
  setConceptRelation(
    fromConcept: string,
    toConcept: string,
    relationType: RelationType,
    opts?: { codePath?: string; weight?: number },
  ): ConceptRelationSummary;
  unsetConceptRelation(
    fromConcept: string,
    toConcept: string,
    opts?: { codePath?: string; relationType?: RelationType },
  ): { removed: number };
  listConceptRelations(opts?: {
    codePath?: string;
    concept?: string;
    includeInactive?: boolean;
  }): ConceptRelationSummary[];
  tagConcept(concept: string, tag: string, opts?: { codePath?: string }): ConceptTagSummary;
  untagConcept(
    concept: string,
    tag: string,
    opts?: { codePath?: string },
  ): { concept: string; tag: string; removed: number };
  listConceptTags(opts?: { codePath?: string; concept?: string }): ConceptTagSummary[];
  computeConceptHealth(opts?: {
    codePath?: string;
    top?: number;
  }): Promise<ConceptHealthComputeResult>;
  explainConceptHealth(
    concept: string,
    opts?: { codePath?: string; neighborLimit?: number; recompute?: boolean },
  ): Promise<ConceptHealthExplainResult>;
  healConcepts(opts?: {
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
  }): Promise<HealConceptsResult>;
  rebuild(opts?: { codePath?: string }): Promise<RebuildResult>;
  reEmbed(opts?: {
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
  }>;
  dryRunClose(narrative: string, opts?: { codePath?: string }): Promise<DryRunCloseResult>;
  migrate(opts?: { codePath?: string }): { applied: number };
  migrateStatus(opts?: { codePath?: string }): MigrationStatus;
  repair(opts?: { codePath?: string } & SchemaRepairOptions): SchemaRepairResult;
  commitLog(opts?: { codePath?: string; limit?: number; since?: string }): CommitLogEntry[];
  listLoreMinds(): Array<{ name: string } & RegistryEntry>;
  removeLoreMind(name: string, deleteData: boolean): void;
  resetLoreMind(opts?: { codePath?: string }): { name: string; lorePath: string };
  listProviderCredentials(): Array<{ provider: SharedProvider; config: ProviderCredential }>;
  getProviderCredential(provider: SharedProvider): ProviderCredential | undefined;
  setProviderCredential(provider: SharedProvider, config: ProviderCredential): ProviderCredential;
  unsetProviderCredential(
    provider: SharedProvider,
    opts?: { api_key?: boolean; base_url?: boolean },
  ): ProviderCredential | undefined;
  getLoreMindConfig(opts?: { codePath?: string }): LoreMindConfigResult;
  setLoreMindConfig(key: string, value: unknown, opts?: { codePath?: string }): void;
  unsetLoreMindConfig(key: string, opts?: { codePath?: string }): void;
  cloneLoreMindConfig(
    sourceLoreMindName: string,
    opts?: { codePath?: string },
  ): LoreMindConfigCloneResult;
  getPromptPreview(
    key: GenerationPromptKey | "all",
    opts?: { codePath?: string },
  ): PromptPreviewResult[];
  suggest(opts?: {
    codePath?: string;
    limit?: number;
    kind?: SuggestionKind | SuggestionKind[];
  }): Promise<SuggestResult>;
  conceptBindings(concept: string, opts?: { codePath?: string }): ConceptBindingSummary[];
  bindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string; confidence?: number },
  ): ConceptBindingSummary;
  unbindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string },
  ): { removed: boolean };
  symbolDrift(opts?: { codePath?: string }): SymbolDriftResult[];
  rebindAll(opts?: {
    codePath?: string;
  }): Promise<{ bound: number; byType: { ref: number; mention: number } }>;
  rescan(opts?: { codePath?: string }): Promise<ScanResult>;
  ingestDoc(filePath: string, opts?: { codePath?: string }): Promise<IngestResult>;
  ingestAll(opts?: { codePath?: string }): Promise<{ scan: ScanResult; ingest: IngestResult }>;
  autoBind(opts?: { codePath?: string }): Promise<AutoBindResult>;
  symbolSearch(
    query: string,
    opts?: { codePath?: string; limit?: number; kind?: SymbolKind },
  ): SymbolSearchResult[];
  fileSymbols(filePath: string, opts?: { codePath?: string }): SymbolRow[];
  scanStats(opts?: { codePath?: string }): ScanStats;
  coverageReport(opts?: { codePath?: string; limit?: number; filePath?: string }): CoverageReport;
  bootstrapPlan(opts?: { codePath?: string }): BootstrapPlan;
  recallResult(
    resultId: string,
    opts?: { codePath?: string; section?: RecallSection },
  ): RecallResult | null;
  scoreResult(
    resultId: string,
    score: number,
    opts?: { codePath?: string; scoredBy?: string },
  ): void;
}

export interface LoreClientOptions {
  configOverrides?: Partial<LoreConfig>;
  engine?: LoreClientEngine;
}

export class LoreClient {
  private readonly engine: LoreClientEngine;

  constructor(options?: LoreClientOptions) {
    this.engine = options?.engine ?? new LoreEngine(options?.configOverrides);
  }

  shutdown(): void {
    this.engine.shutdown();
  }

  register(codePath: string, name?: string): Promise<RegisterResult> {
    return this.engine.register(codePath, name);
  }

  open(
    narrative: string,
    intent: string,
    opts?: {
      codePath?: string;
      resolveDangling?: ResolveDangling;
      targets?: NarrativeTarget[];
      fromResultId?: string;
    },
  ): Promise<OpenResult> {
    return this.engine.open(narrative, intent, opts);
  }

  write(
    narrative: string,
    entry: string,
    opts: {
      topics?: string[];
      codePath?: string;
      refs?: FileRef[];
      concepts: string[];
      symbols?: string[];
    },
  ): Promise<LogResult> {
    return this.engine.log(narrative, entry, { ...opts, topics: opts.topics ?? [] });
  }

  log(
    narrative: string,
    entry: string,
    opts: {
      topics?: string[];
      codePath?: string;
      refs?: FileRef[];
      concepts: string[];
      symbols?: string[];
    },
  ): Promise<LogResult> {
    return this.write(narrative, entry, opts);
  }

  designateJournalEntry(
    narrative: string,
    chunkId: string,
    opts: { concepts?: string[]; codePath?: string },
  ): Promise<JournalDesignationResult> {
    return this.engine.designateJournalEntry(narrative, chunkId, opts);
  }

  ask(query: string, opts?: QueryOptions): Promise<QueryResult> {
    return this.engine.query(query, opts);
  }

  query(query: string, opts?: QueryOptions): Promise<QueryResult> {
    return this.ask(query, opts);
  }

  queryForOrchestration(query: string, opts?: OrchestrationQueryOptions): Promise<QueryResult> {
    return this.engine.queryForOrchestration(query, opts);
  }

  searchWeb(query: string, opts?: { codePath?: string }): Promise<WebSearchResult[]> {
    return this.engine.searchWeb(query, opts);
  }

  summarizeMatches(
    query: string,
    matches: Array<{ concept: string; score: number; content: string; lore_mind?: string }>,
    opts?: {
      codePath?: string;
      timeoutMs?: number;
      systemPrompt?: string;
      reasoning?: "none" | "low" | "default" | "high";
      maxMatches?: number;
      maxChars?: number;
    },
  ): Promise<ExecutiveSummary | undefined> {
    return this.engine.summarizeMatches(query, matches, opts);
  }

  close(
    narrative: string,
    opts?: {
      codePath?: string;
      mode?: CloseMode;
      mergeStrategy?: MergeStrategy;
      fromResultId?: string;
      wait?: boolean;
      pollMs?: number;
    },
  ): Promise<CloseResult> {
    return this.engine.close(narrative, opts);
  }

  listCloseJobs(opts?: { codePath?: string; limit?: number }): Promise<CloseJob[]> {
    return this.engine.listCloseJobs(opts);
  }

  getCloseJobDetail(jobId: string, opts?: { codePath?: string }): Promise<CloseJobDetail> {
    return this.engine.getCloseJobDetail(jobId, opts);
  }

  waitForCloseJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<CloseResult> {
    return this.engine.waitForCloseJob(jobId, opts);
  }

  runCloseWorker(opts?: {
    codePath?: string;
    watch?: boolean;
    pollMs?: number;
  }): Promise<CloseWorkerRunResult> {
    return this.engine.runCloseWorker(opts);
  }

  status(opts?: { codePath?: string }): Promise<StatusResult> {
    return this.engine.status(opts);
  }

  healthSnapshot(opts?: { codePath?: string }): LoreHealthSnapshot {
    return this.engine.healthSnapshot(opts);
  }

  ls(opts?: { codePath?: string }): Promise<LsResult> {
    return this.engine.ls(opts);
  }

  show(
    concept: string,
    opts?: { codePath?: string; ref?: string; fromResultId?: string },
  ): Promise<ShowResult> {
    return this.engine.show(concept, opts);
  }

  history(concept: string, opts?: { codePath?: string }): Promise<HistoryResult> {
    return this.engine.history(concept, opts);
  }

  showNarrativeTrail(
    narrativeName: string,
    opts?: { codePath?: string; fromResultId?: string },
  ): Promise<NarrativeTrailResult> {
    return this.engine.showNarrativeTrail(narrativeName, opts);
  }

  diff(
    fromRef: string,
    toRef: string,
    opts?: { codePath?: string; includeContent?: boolean },
  ): Promise<TreeDiff> {
    return this.engine.diffCommits(fromRef, toRef, opts);
  }

  diffCommits(
    fromRef: string,
    toRef: string,
    opts?: { codePath?: string; includeContent?: boolean },
  ): Promise<TreeDiff> {
    return this.engine.diffCommits(fromRef, toRef, opts);
  }

  conceptRename(from: string, to: string, opts?: { codePath?: string }): Promise<LifecycleResult> {
    return this.engine.conceptRename(from, to, opts);
  }

  conceptArchive(
    concept: string,
    opts?: { codePath?: string; reason?: string },
  ): Promise<LifecycleResult> {
    return this.engine.conceptArchive(concept, opts);
  }

  conceptRestore(concept: string, opts?: { codePath?: string }): Promise<LifecycleResult> {
    return this.engine.conceptRestore(concept, opts);
  }

  conceptMerge(
    source: string,
    target: string,
    opts?: { codePath?: string; reason?: string; preview?: boolean },
  ): Promise<LifecycleResult> {
    return this.engine.conceptMerge(source, target, opts);
  }

  conceptSplit(
    concept: string,
    opts?: { codePath?: string; parts?: number; preview?: boolean },
  ): Promise<LifecycleResult> {
    return this.engine.conceptSplit(concept, opts);
  }

  conceptPatch(
    concept: string,
    text: string,
    opts?: { codePath?: string; topics?: string[]; direct?: boolean },
  ): Promise<LifecycleResult> {
    return this.engine.conceptPatch(concept, text, opts);
  }

  setConceptRelation(
    fromConcept: string,
    toConcept: string,
    relationType: RelationType,
    opts?: { codePath?: string; weight?: number },
  ): ConceptRelationSummary {
    return this.engine.setConceptRelation(fromConcept, toConcept, relationType, opts);
  }

  unsetConceptRelation(
    fromConcept: string,
    toConcept: string,
    opts?: { codePath?: string; relationType?: RelationType },
  ): { removed: number } {
    return this.engine.unsetConceptRelation(fromConcept, toConcept, opts);
  }

  listConceptRelations(opts?: {
    codePath?: string;
    concept?: string;
    includeInactive?: boolean;
  }): ConceptRelationSummary[] {
    return this.engine.listConceptRelations(opts);
  }

  tagConcept(concept: string, tag: string, opts?: { codePath?: string }): ConceptTagSummary {
    return this.engine.tagConcept(concept, tag, opts);
  }

  untagConcept(
    concept: string,
    tag: string,
    opts?: { codePath?: string },
  ): { concept: string; tag: string; removed: number } {
    return this.engine.untagConcept(concept, tag, opts);
  }

  listConceptTags(opts?: { codePath?: string; concept?: string }): ConceptTagSummary[] {
    return this.engine.listConceptTags(opts);
  }

  computeConceptHealth(opts?: {
    codePath?: string;
    top?: number;
  }): Promise<ConceptHealthComputeResult> {
    return this.engine.computeConceptHealth(opts);
  }

  explainConceptHealth(
    concept: string,
    opts?: { codePath?: string; neighborLimit?: number; recompute?: boolean },
  ): Promise<ConceptHealthExplainResult> {
    return this.engine.explainConceptHealth(concept, opts);
  }

  healConcepts(opts?: {
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
    return this.engine.healConcepts(opts);
  }

  rebuild(opts?: { codePath?: string }): Promise<RebuildResult> {
    return this.engine.rebuild(opts);
  }

  refreshEmbeddings(opts?: {
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
    return this.engine.reEmbed(opts);
  }

  reEmbed(opts?: {
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
    return this.engine.reEmbed(opts);
  }

  dryRunClose(narrative: string, opts?: { codePath?: string }): Promise<DryRunCloseResult> {
    return this.engine.dryRunClose(narrative, opts);
  }

  migrate(opts?: { codePath?: string }): { applied: number } {
    return this.engine.migrate(opts);
  }

  migrateStatus(opts?: { codePath?: string }): MigrationStatus {
    return this.engine.migrateStatus(opts);
  }

  repair(opts?: { codePath?: string } & SchemaRepairOptions): SchemaRepairResult {
    return this.engine.repair(opts);
  }

  commitLog(opts?: { codePath?: string; limit?: number; since?: string }): CommitLogEntry[] {
    return this.engine.commitLog(opts);
  }

  listLoreMinds(): Array<{ name: string } & RegistryEntry> {
    return this.engine.listLoreMinds();
  }

  removeLoreMind(name: string, deleteData: boolean = true): void {
    return this.engine.removeLoreMind(name, deleteData);
  }

  resetLoreMind(opts?: { codePath?: string }): { name: string; lorePath: string } {
    return this.engine.resetLoreMind(opts);
  }

  listProviderCredentials(): Array<{ provider: SharedProvider; config: ProviderCredential }> {
    return this.engine.listProviderCredentials();
  }

  getProviderCredential(provider: SharedProvider): ProviderCredential | undefined {
    return this.engine.getProviderCredential(provider);
  }

  setProviderCredential(provider: SharedProvider, config: ProviderCredential): ProviderCredential {
    return this.engine.setProviderCredential(provider, config);
  }

  unsetProviderCredential(
    provider: SharedProvider,
    opts?: { apiKey?: boolean; baseUrl?: boolean; api_key?: boolean; base_url?: boolean },
  ): ProviderCredential | undefined {
    const fields = opts
      ? {
          ...(opts.apiKey !== undefined ? { api_key: opts.apiKey } : {}),
          ...(opts.baseUrl !== undefined ? { base_url: opts.baseUrl } : {}),
          ...(opts.api_key !== undefined ? { api_key: opts.api_key } : {}),
          ...(opts.base_url !== undefined ? { base_url: opts.base_url } : {}),
        }
      : undefined;
    return this.engine.unsetProviderCredential(provider, fields);
  }

  getLoreMindConfig(opts?: { codePath?: string }): LoreMindConfigResult {
    return this.engine.getLoreMindConfig(opts);
  }

  setLoreMindConfig(key: string, value: unknown, opts?: { codePath?: string }): void {
    return this.engine.setLoreMindConfig(key, value, opts);
  }

  unsetLoreMindConfig(key: string, opts?: { codePath?: string }): void {
    return this.engine.unsetLoreMindConfig(key, opts);
  }

  cloneLoreMindConfig(
    sourceLoreMindName: string,
    opts?: { codePath?: string },
  ): LoreMindConfigCloneResult {
    return this.engine.cloneLoreMindConfig(sourceLoreMindName, opts);
  }

  getPromptPreview(
    key: GenerationPromptKey | "all",
    opts?: { codePath?: string },
  ): PromptPreviewResult[] {
    return this.engine.getPromptPreview(key, opts);
  }

  suggest(opts?: {
    codePath?: string;
    limit?: number;
    kind?: SuggestionKind | SuggestionKind[];
  }): Promise<SuggestResult> {
    return this.engine.suggest(opts);
  }

  conceptBindings(concept: string, opts?: { codePath?: string }): ConceptBindingSummary[] {
    return this.engine.conceptBindings(concept, opts);
  }

  bindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string; confidence?: number },
  ): ConceptBindingSummary {
    return this.engine.bindSymbol(concept, symbolQualifiedName, opts);
  }

  unbindSymbol(
    concept: string,
    symbolQualifiedName: string,
    opts?: { codePath?: string },
  ): { removed: boolean } {
    return this.engine.unbindSymbol(concept, symbolQualifiedName, opts);
  }

  symbolDrift(opts?: { codePath?: string }): SymbolDriftResult[] {
    return this.engine.symbolDrift(opts);
  }

  rebindAll(opts?: {
    codePath?: string;
  }): Promise<{ bound: number; byType: { ref: number; mention: number } }> {
    return this.engine.rebindAll(opts);
  }

  rescan(opts?: { codePath?: string }): Promise<ScanResult> {
    return this.engine.rescan(opts);
  }

  ingestDoc(filePath: string, opts?: { codePath?: string }): Promise<IngestResult> {
    return this.engine.ingestDoc(filePath, opts);
  }

  ingestAll(opts?: { codePath?: string }): Promise<{ scan: ScanResult; ingest: IngestResult }> {
    return this.engine.ingestAll(opts);
  }

  autoBind(opts?: { codePath?: string }): Promise<AutoBindResult> {
    return this.engine.autoBind(opts);
  }

  symbolSearch(
    query: string,
    opts?: { codePath?: string; limit?: number; kind?: SymbolKind },
  ): SymbolSearchResult[] {
    return this.engine.symbolSearch(query, opts);
  }

  fileSymbols(filePath: string, opts?: { codePath?: string }): SymbolRow[] {
    return this.engine.fileSymbols(filePath, opts);
  }

  scanStats(opts?: { codePath?: string }): ScanStats {
    return this.engine.scanStats(opts);
  }

  coverageReport(opts?: { codePath?: string; limit?: number; filePath?: string }): CoverageReport {
    return this.engine.coverageReport(opts);
  }

  bootstrapPlan(opts?: { codePath?: string }): BootstrapPlan {
    return this.engine.bootstrapPlan(opts);
  }

  recall(
    resultId: string,
    opts?: { codePath?: string; section?: RecallSection },
  ): RecallResult | null {
    return this.engine.recallResult(resultId, opts);
  }

  scoreResult(
    resultId: string,
    score: number,
    opts?: { codePath?: string; scoredBy?: string },
  ): void {
    return this.engine.scoreResult(resultId, score, opts);
  }
}

export function formatCoverage(
  report: CoverageReport,
  opts?: { showUncovered?: boolean; filePath?: string },
): string {
  const compactCount = (value: number): string => {
    const abs = Math.abs(value);
    if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
    if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
    return String(value);
  };

  const lines: string[] = [];
  const { stats, coverage_ratio, files, uncovered } = report;

  const pct = (coverage_ratio * 100).toFixed(0);
  lines.push(
    `Coverage: ${pct}% (${compactCount(stats.bound_exported)}/${compactCount(stats.total_exported)} exported symbols bound)`,
  );

  if (opts?.filePath) {
    const file = files.find((f) => f.file_path === opts.filePath);
    if (file) {
      const filePct = (file.coverage_ratio * 100).toFixed(0);
      lines.push(
        `\n${file.file_path}  ${compactCount(file.bound_count)}/${compactCount(file.symbol_count)}  (${filePct}%)`,
      );
    }
    if (uncovered.length > 0) {
      lines.push("");
      for (const sym of uncovered) {
        lines.push(`  ${sym.kind} ${sym.name}  ${sym.file_path}:${sym.line_start}`);
      }
    }
    return lines.join("\n");
  }

  if (files.length > 0) {
    lines.push("\nLeast covered files:");
    const worst = files.filter((f) => f.coverage_ratio < 1).slice(0, 10);
    for (const f of worst) {
      const filePct = (f.coverage_ratio * 100).toFixed(0);
      lines.push(
        `  ${f.file_path.padEnd(40)} ${compactCount(f.bound_count)}/${compactCount(f.symbol_count)}  (${filePct}%)`,
      );
    }
  }

  if (opts?.showUncovered && uncovered.length > 0) {
    lines.push("\nUncovered exported symbols:");
    for (const sym of uncovered) {
      lines.push(
        `  ${sym.kind.padEnd(10)} ${sym.name.padEnd(30)} ${sym.file_path}:${sym.line_start}`,
      );
    }
  }

  return lines.join("\n");
}

export function createLoreClient(options?: LoreClientOptions): LoreClient {
  return new LoreClient(options);
}
