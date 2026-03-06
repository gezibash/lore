import {
  GENERATION_PROMPT_KEYS,
  LoreError,
  createLoreClient,
  computeLineDiff,
  isDiffTooLarge,
  describeSchemaIssue,
  formatBindings,
  formatBootstrapPlan,
  formatClose,
  formatCommitLog,
  formatCoverage,
  formatNarrativeTrail,
  formatDryRunClose,
  formatHistory,
  formatLifecycleResult,
  formatLog,
  formatLs,
  formatOpen,
  formatQuery,
  formatShow,
  formatStatus,
  formatSuggest,
  formatTreeDiff,
  getDeepValue,
  normalizePromptKey,
  renderExecutiveSummary,
  renderNarrativeWithCitations,
  renderProvenance,
  timeAgo,
  type NarrativeTarget,
  type LoreClient,
  type LoreClientOptions,
  type ResolveDangling,
} from "@lore/sdk";

export type * from "@lore/sdk";
export {
  LoreError,
  getDeepValue,
  normalizePromptKey,
  GENERATION_PROMPT_KEYS,
  describeSchemaIssue,
  computeLineDiff,
  isDiffTooLarge,
  timeAgo,
  formatOpen,
  formatLog,
  formatQuery,
  formatClose,
  formatCoverage,
  formatNarrativeTrail,
  formatDryRunClose,
  formatStatus,
  formatLs,
  formatShow,
  formatHistory,
  formatLifecycleResult,
  formatSuggest,
  formatBindings,
  formatTreeDiff,
  formatCommitLog,
  formatBootstrapPlan,
  renderExecutiveSummary,
  renderNarrativeWithCitations,
  renderProvenance,
};

type WorkerClientDeps = Pick<
  LoreClient,
  | "shutdown"
  | "open"
  | "write"
  | "log"
  | "designateJournalEntry"
  | "ask"
  | "query"
  | "close"
  | "status"
  | "ls"
  | "show"
  | "history"
  | "showNarrativeTrail"
  | "diff"
  | "diffCommits"
  | "conceptRename"
  | "conceptArchive"
  | "conceptRestore"
  | "conceptMerge"
  | "conceptSplit"
  | "conceptPatch"
  | "setConceptRelation"
  | "unsetConceptRelation"
  | "listConceptRelations"
  | "tagConcept"
  | "untagConcept"
  | "listConceptTags"
  | "computeConceptHealth"
  | "explainConceptHealth"
  | "healConcepts"
  | "rebuild"
  | "refreshEmbeddings"
  | "reEmbed"
  | "dryRunClose"
  | "commitLog"
  | "resetLoreMind"
  | "getLoreMindConfig"
  | "setLoreMindConfig"
  | "unsetLoreMindConfig"
  | "cloneLoreMindConfig"
  | "getPromptPreview"
  | "suggest"
  | "conceptBindings"
  | "bindSymbol"
  | "unbindSymbol"
  | "symbolDrift"
  | "rebindAll"
  | "rescan"
  | "ingestDoc"
  | "ingestAll"
  | "autoBind"
  | "symbolSearch"
  | "fileSymbols"
  | "scanStats"
  | "coverageReport"
  | "bootstrapPlan"
  | "recall"
  | "scoreResult"
  | "register"
  | "migrate"
  | "migrateStatus"
  | "repair"
  | "listLoreMinds"
  | "removeLoreMind"
  | "listProviderCredentials"
  | "getProviderCredential"
  | "setProviderCredential"
  | "unsetProviderCredential"
>;

export interface WorkerClientOptions extends LoreClientOptions {
  client?: WorkerClientDeps;
}

export class WorkerClient {
  private readonly client: WorkerClientDeps;

  constructor(options?: WorkerClientOptions) {
    const { client, ...clientOptions } = options ?? {};
    this.client = client ?? createLoreClient(clientOptions);
  }

  shutdown(): void {
    this.client.shutdown();
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
  ): ReturnType<WorkerClientDeps["open"]> {
    return this.client.open(narrative, intent, opts);
  }

  write(...args: Parameters<WorkerClientDeps["write"]>): ReturnType<WorkerClientDeps["write"]> {
    return this.client.write(...args);
  }

  log(...args: Parameters<WorkerClientDeps["log"]>): ReturnType<WorkerClientDeps["log"]> {
    return this.client.log(...args);
  }

  designateJournalEntry(
    ...args: Parameters<WorkerClientDeps["designateJournalEntry"]>
  ): ReturnType<WorkerClientDeps["designateJournalEntry"]> {
    return this.client.designateJournalEntry(...args);
  }

  ask(...args: Parameters<WorkerClientDeps["ask"]>): ReturnType<WorkerClientDeps["ask"]> {
    return this.client.ask(...args);
  }

  query(...args: Parameters<WorkerClientDeps["query"]>): ReturnType<WorkerClientDeps["query"]> {
    return this.client.query(...args);
  }

  close(...args: Parameters<WorkerClientDeps["close"]>): ReturnType<WorkerClientDeps["close"]> {
    return this.client.close(...args);
  }

  status(...args: Parameters<WorkerClientDeps["status"]>): ReturnType<WorkerClientDeps["status"]> {
    return this.client.status(...args);
  }

  ls(...args: Parameters<WorkerClientDeps["ls"]>): ReturnType<WorkerClientDeps["ls"]> {
    return this.client.ls(...args);
  }

  show(...args: Parameters<WorkerClientDeps["show"]>): ReturnType<WorkerClientDeps["show"]> {
    return this.client.show(...args);
  }

  history(
    ...args: Parameters<WorkerClientDeps["history"]>
  ): ReturnType<WorkerClientDeps["history"]> {
    return this.client.history(...args);
  }

  showNarrativeTrail(
    ...args: Parameters<WorkerClientDeps["showNarrativeTrail"]>
  ): ReturnType<WorkerClientDeps["showNarrativeTrail"]> {
    return this.client.showNarrativeTrail(...args);
  }

  diff(...args: Parameters<WorkerClientDeps["diff"]>): ReturnType<WorkerClientDeps["diff"]> {
    return this.client.diff(...args);
  }

  diffCommits(
    ...args: Parameters<WorkerClientDeps["diffCommits"]>
  ): ReturnType<WorkerClientDeps["diffCommits"]> {
    return this.client.diffCommits(...args);
  }

  conceptRename(
    ...args: Parameters<WorkerClientDeps["conceptRename"]>
  ): ReturnType<WorkerClientDeps["conceptRename"]> {
    return this.client.conceptRename(...args);
  }

  conceptArchive(
    ...args: Parameters<WorkerClientDeps["conceptArchive"]>
  ): ReturnType<WorkerClientDeps["conceptArchive"]> {
    return this.client.conceptArchive(...args);
  }

  conceptRestore(
    ...args: Parameters<WorkerClientDeps["conceptRestore"]>
  ): ReturnType<WorkerClientDeps["conceptRestore"]> {
    return this.client.conceptRestore(...args);
  }

  conceptMerge(
    ...args: Parameters<WorkerClientDeps["conceptMerge"]>
  ): ReturnType<WorkerClientDeps["conceptMerge"]> {
    return this.client.conceptMerge(...args);
  }

  conceptSplit(
    ...args: Parameters<WorkerClientDeps["conceptSplit"]>
  ): ReturnType<WorkerClientDeps["conceptSplit"]> {
    return this.client.conceptSplit(...args);
  }

  conceptPatch(
    ...args: Parameters<WorkerClientDeps["conceptPatch"]>
  ): ReturnType<WorkerClientDeps["conceptPatch"]> {
    return this.client.conceptPatch(...args);
  }

  setConceptRelation(
    ...args: Parameters<WorkerClientDeps["setConceptRelation"]>
  ): ReturnType<WorkerClientDeps["setConceptRelation"]> {
    return this.client.setConceptRelation(...args);
  }

  unsetConceptRelation(
    ...args: Parameters<WorkerClientDeps["unsetConceptRelation"]>
  ): ReturnType<WorkerClientDeps["unsetConceptRelation"]> {
    return this.client.unsetConceptRelation(...args);
  }

  listConceptRelations(
    ...args: Parameters<WorkerClientDeps["listConceptRelations"]>
  ): ReturnType<WorkerClientDeps["listConceptRelations"]> {
    return this.client.listConceptRelations(...args);
  }

  tagConcept(
    ...args: Parameters<WorkerClientDeps["tagConcept"]>
  ): ReturnType<WorkerClientDeps["tagConcept"]> {
    return this.client.tagConcept(...args);
  }

  untagConcept(
    ...args: Parameters<WorkerClientDeps["untagConcept"]>
  ): ReturnType<WorkerClientDeps["untagConcept"]> {
    return this.client.untagConcept(...args);
  }

  listConceptTags(
    ...args: Parameters<WorkerClientDeps["listConceptTags"]>
  ): ReturnType<WorkerClientDeps["listConceptTags"]> {
    return this.client.listConceptTags(...args);
  }

  computeConceptHealth(
    ...args: Parameters<WorkerClientDeps["computeConceptHealth"]>
  ): ReturnType<WorkerClientDeps["computeConceptHealth"]> {
    return this.client.computeConceptHealth(...args);
  }

  explainConceptHealth(
    ...args: Parameters<WorkerClientDeps["explainConceptHealth"]>
  ): ReturnType<WorkerClientDeps["explainConceptHealth"]> {
    return this.client.explainConceptHealth(...args);
  }

  healConcepts(
    ...args: Parameters<WorkerClientDeps["healConcepts"]>
  ): ReturnType<WorkerClientDeps["healConcepts"]> {
    return this.client.healConcepts(...args);
  }

  rebuild(
    ...args: Parameters<WorkerClientDeps["rebuild"]>
  ): ReturnType<WorkerClientDeps["rebuild"]> {
    return this.client.rebuild(...args);
  }

  refreshEmbeddings(
    ...args: Parameters<WorkerClientDeps["refreshEmbeddings"]>
  ): ReturnType<WorkerClientDeps["refreshEmbeddings"]> {
    return this.client.refreshEmbeddings(...args);
  }

  reEmbed(
    ...args: Parameters<WorkerClientDeps["reEmbed"]>
  ): ReturnType<WorkerClientDeps["reEmbed"]> {
    return this.client.reEmbed(...args);
  }

  dryRunClose(
    ...args: Parameters<WorkerClientDeps["dryRunClose"]>
  ): ReturnType<WorkerClientDeps["dryRunClose"]> {
    return this.client.dryRunClose(...args);
  }

  commitLog(
    ...args: Parameters<WorkerClientDeps["commitLog"]>
  ): ReturnType<WorkerClientDeps["commitLog"]> {
    return this.client.commitLog(...args);
  }

  resetLoreMind(
    ...args: Parameters<WorkerClientDeps["resetLoreMind"]>
  ): ReturnType<WorkerClientDeps["resetLoreMind"]> {
    return this.client.resetLoreMind(...args);
  }

  getLoreMindConfig(
    ...args: Parameters<WorkerClientDeps["getLoreMindConfig"]>
  ): ReturnType<WorkerClientDeps["getLoreMindConfig"]> {
    return this.client.getLoreMindConfig(...args);
  }

  setLoreMindConfig(
    ...args: Parameters<WorkerClientDeps["setLoreMindConfig"]>
  ): ReturnType<WorkerClientDeps["setLoreMindConfig"]> {
    return this.client.setLoreMindConfig(...args);
  }

  unsetLoreMindConfig(
    ...args: Parameters<WorkerClientDeps["unsetLoreMindConfig"]>
  ): ReturnType<WorkerClientDeps["unsetLoreMindConfig"]> {
    return this.client.unsetLoreMindConfig(...args);
  }

  cloneLoreMindConfig(
    ...args: Parameters<WorkerClientDeps["cloneLoreMindConfig"]>
  ): ReturnType<WorkerClientDeps["cloneLoreMindConfig"]> {
    return this.client.cloneLoreMindConfig(...args);
  }

  getPromptPreview(
    ...args: Parameters<WorkerClientDeps["getPromptPreview"]>
  ): ReturnType<WorkerClientDeps["getPromptPreview"]> {
    return this.client.getPromptPreview(...args);
  }

  suggest(
    ...args: Parameters<WorkerClientDeps["suggest"]>
  ): ReturnType<WorkerClientDeps["suggest"]> {
    return this.client.suggest(...args);
  }

  conceptBindings(
    ...args: Parameters<WorkerClientDeps["conceptBindings"]>
  ): ReturnType<WorkerClientDeps["conceptBindings"]> {
    return this.client.conceptBindings(...args);
  }

  bindSymbol(
    ...args: Parameters<WorkerClientDeps["bindSymbol"]>
  ): ReturnType<WorkerClientDeps["bindSymbol"]> {
    return this.client.bindSymbol(...args);
  }

  unbindSymbol(
    ...args: Parameters<WorkerClientDeps["unbindSymbol"]>
  ): ReturnType<WorkerClientDeps["unbindSymbol"]> {
    return this.client.unbindSymbol(...args);
  }

  symbolDrift(
    ...args: Parameters<WorkerClientDeps["symbolDrift"]>
  ): ReturnType<WorkerClientDeps["symbolDrift"]> {
    return this.client.symbolDrift(...args);
  }

  rebindAll(
    ...args: Parameters<WorkerClientDeps["rebindAll"]>
  ): ReturnType<WorkerClientDeps["rebindAll"]> {
    return this.client.rebindAll(...args);
  }

  rescan(...args: Parameters<WorkerClientDeps["rescan"]>): ReturnType<WorkerClientDeps["rescan"]> {
    return this.client.rescan(...args);
  }

  ingestDoc(
    ...args: Parameters<WorkerClientDeps["ingestDoc"]>
  ): ReturnType<WorkerClientDeps["ingestDoc"]> {
    return this.client.ingestDoc(...args);
  }

  ingestAll(
    ...args: Parameters<WorkerClientDeps["ingestAll"]>
  ): ReturnType<WorkerClientDeps["ingestAll"]> {
    return this.client.ingestAll(...args);
  }

  autoBind(
    ...args: Parameters<WorkerClientDeps["autoBind"]>
  ): ReturnType<WorkerClientDeps["autoBind"]> {
    return this.client.autoBind(...args);
  }

  symbolSearch(
    ...args: Parameters<WorkerClientDeps["symbolSearch"]>
  ): ReturnType<WorkerClientDeps["symbolSearch"]> {
    return this.client.symbolSearch(...args);
  }

  fileSymbols(
    ...args: Parameters<WorkerClientDeps["fileSymbols"]>
  ): ReturnType<WorkerClientDeps["fileSymbols"]> {
    return this.client.fileSymbols(...args);
  }

  scanStats(
    ...args: Parameters<WorkerClientDeps["scanStats"]>
  ): ReturnType<WorkerClientDeps["scanStats"]> {
    return this.client.scanStats(...args);
  }

  coverageReport(
    ...args: Parameters<WorkerClientDeps["coverageReport"]>
  ): ReturnType<WorkerClientDeps["coverageReport"]> {
    return this.client.coverageReport(...args);
  }

  bootstrapPlan(
    ...args: Parameters<WorkerClientDeps["bootstrapPlan"]>
  ): ReturnType<WorkerClientDeps["bootstrapPlan"]> {
    return this.client.bootstrapPlan(...args);
  }

  recall(
    ...args: Parameters<WorkerClientDeps["recall"]>
  ): ReturnType<WorkerClientDeps["recall"]> {
    return this.client.recall(...args);
  }

  scoreResult(
    ...args: Parameters<WorkerClientDeps["scoreResult"]>
  ): ReturnType<WorkerClientDeps["scoreResult"]> {
    return this.client.scoreResult(...args);
  }

  register(
    ...args: Parameters<WorkerClientDeps["register"]>
  ): ReturnType<WorkerClientDeps["register"]> {
    return this.client.register(...args);
  }

  migrate(
    ...args: Parameters<WorkerClientDeps["migrate"]>
  ): ReturnType<WorkerClientDeps["migrate"]> {
    return this.client.migrate(...args);
  }

  migrateStatus(
    ...args: Parameters<WorkerClientDeps["migrateStatus"]>
  ): ReturnType<WorkerClientDeps["migrateStatus"]> {
    return this.client.migrateStatus(...args);
  }

  repair(
    ...args: Parameters<WorkerClientDeps["repair"]>
  ): ReturnType<WorkerClientDeps["repair"]> {
    return this.client.repair(...args);
  }

  listLoreMinds(
    ...args: Parameters<WorkerClientDeps["listLoreMinds"]>
  ): ReturnType<WorkerClientDeps["listLoreMinds"]> {
    return this.client.listLoreMinds(...args);
  }

  removeLoreMind(
    ...args: Parameters<WorkerClientDeps["removeLoreMind"]>
  ): ReturnType<WorkerClientDeps["removeLoreMind"]> {
    return this.client.removeLoreMind(...args);
  }

  listProviderCredentials(
    ...args: Parameters<WorkerClientDeps["listProviderCredentials"]>
  ): ReturnType<WorkerClientDeps["listProviderCredentials"]> {
    return this.client.listProviderCredentials(...args);
  }

  getProviderCredential(
    ...args: Parameters<WorkerClientDeps["getProviderCredential"]>
  ): ReturnType<WorkerClientDeps["getProviderCredential"]> {
    return this.client.getProviderCredential(...args);
  }

  setProviderCredential(
    ...args: Parameters<WorkerClientDeps["setProviderCredential"]>
  ): ReturnType<WorkerClientDeps["setProviderCredential"]> {
    return this.client.setProviderCredential(...args);
  }

  unsetProviderCredential(
    ...args: Parameters<WorkerClientDeps["unsetProviderCredential"]>
  ): ReturnType<WorkerClientDeps["unsetProviderCredential"]> {
    return this.client.unsetProviderCredential(...args);
  }
}

export function createWorkerClient(options?: WorkerClientOptions): WorkerClient {
  return new WorkerClient(options);
}
