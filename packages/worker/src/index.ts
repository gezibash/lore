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
  type CloseResult,
  type CloseWorkerRunResult,
  type CloseJob,
  type CloseJobDetail,
  type IngestResult,
  type RebuildResult,
  type ScanResult,
} from "@lore/sdk";
import {
  LoreDaemonRpcClient,
  getLoreDaemonStatus,
  readLoreDaemonLog,
  startLoreDaemon,
  stopLoreDaemon,
} from "./daemon-client.ts";
import { getLoreDaemonPaths } from "./daemon-paths.ts";
import { runLoreDaemonServer } from "./daemon-server.ts";
import type {
  LoreDaemonLogSnapshot,
  LoreDaemonRunResult,
  LoreDaemonStatus,
  LoreJob,
  LoreJobDetail,
  LoreJobType,
} from "./daemon-protocol.ts";

export type * from "@lore/sdk";
export type {
  LoreDaemonLogSnapshot,
  LoreDaemonRunResult,
  LoreDaemonStatus,
  LoreJob,
  LoreJobDetail,
  LoreJobType,
};
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
export { startLoreDaemon, getLoreDaemonStatus, stopLoreDaemon, readLoreDaemonLog };

type DirectWorkerClientDeps = Pick<
  LoreClient,
  | "shutdown"
  | "open"
  | "write"
  | "log"
  | "designateJournalEntry"
  | "ask"
  | "query"
  | "close"
  | "listCloseJobs"
  | "getCloseJobDetail"
  | "waitForCloseJob"
  | "runCloseWorker"
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

type AwaitedReturn<T> = Promise<Awaited<T>>;

const DAEMON_ROUTED_METHODS = new Set<string>([
  "register",
  "open",
  "write",
  "log",
  "designateJournalEntry",
  "ask",
  "query",
  "close",
  "status",
  "show",
  "showNarrativeTrail",
  "recall",
  "scoreResult",
  "conceptRename",
  "conceptArchive",
  "conceptRestore",
  "conceptMerge",
  "conceptSplit",
  "conceptPatch",
  "setConceptRelation",
  "unsetConceptRelation",
  "tagConcept",
  "untagConcept",
  "computeConceptHealth",
  "explainConceptHealth",
  "healConcepts",
  "rebuild",
  "refreshEmbeddings",
  "reEmbed",
  "resetLoreMind",
  "setLoreMindConfig",
  "unsetLoreMindConfig",
  "cloneLoreMindConfig",
  "bindSymbol",
  "unbindSymbol",
  "rebindAll",
  "rescan",
  "ingestDoc",
  "ingestAll",
  "autoBind",
  "migrate",
  "repair",
  "removeLoreMind",
  "setProviderCredential",
  "unsetProviderCredential",
  "listJobs",
  "getJobDetail",
  "waitForJob",
  "runCloseWorker",
]);

function toLegacyCloseJob(job: LoreJob): CloseJob {
  return {
    id: job.id,
    narrative_id: job.subject ?? job.id,
    narrative_name: job.subject ?? "unknown",
    status: job.status,
    owner: job.owner,
    attempt: job.attempt,
    lease_expires_at: job.lease_expires_at,
    last_error: job.last_error,
    created_at: job.created_at,
    updated_at: job.updated_at,
    completed_at: job.completed_at,
  };
}

function asCloseResult(detail: LoreJobDetail): CloseResult {
  if (!detail.result || typeof detail.result !== "object") {
    throw new Error(`Close job '${detail.job.id}' has no close result`);
  }
  return {
    ...(detail.result as CloseResult),
    close_job: toLegacyCloseJob(detail.job),
  };
}

export interface WorkerClientOptions extends LoreClientOptions {
  client?: Partial<DirectWorkerClientDeps>;
  daemonClient?: LoreDaemonRpcClient;
  disableDaemon?: boolean;
}

export class WorkerClient {
  private readonly client: Partial<DirectWorkerClientDeps>;
  private readonly daemon: LoreDaemonRpcClient;
  private readonly disableDaemon: boolean;
  private readonly injectedClient: boolean;

  constructor(options?: WorkerClientOptions) {
    const { client, daemonClient, disableDaemon, ...clientOptions } = options ?? {};
    this.client = client ?? (createLoreClient(clientOptions) as DirectWorkerClientDeps);
    this.daemon = daemonClient ?? new LoreDaemonRpcClient(getLoreDaemonPaths());
    this.disableDaemon = disableDaemon ?? process.env.LORE_DAEMON_DISABLE === "1";
    this.injectedClient = Boolean(client);
  }

  shutdown(): void {
    this.client.shutdown?.();
  }

  private useDaemon(method: string): boolean {
    return !this.disableDaemon && !this.injectedClient && DAEMON_ROUTED_METHODS.has(method);
  }

  private async callDirect<K extends keyof DirectWorkerClientDeps>(
    method: K,
    args: Parameters<DirectWorkerClientDeps[K]>,
  ): AwaitedReturn<ReturnType<DirectWorkerClientDeps[K]>> {
    const fn = this.client[method] as ((...args: Parameters<DirectWorkerClientDeps[K]>) => unknown) | undefined;
    if (typeof fn !== "function") {
      throw new Error(`Worker client method '${String(method)}' is unavailable`);
    }
    return (await fn.apply(this.client, args)) as Awaited<ReturnType<DirectWorkerClientDeps[K]>>;
  }

  private async call<K extends keyof DirectWorkerClientDeps>(
    method: K,
    args: Parameters<DirectWorkerClientDeps[K]>,
  ): AwaitedReturn<ReturnType<DirectWorkerClientDeps[K]>> {
    if (!this.useDaemon(String(method))) {
      return this.callDirect(method, args);
    }
    return (await this.daemon.call(String(method), args)) as Awaited<ReturnType<
      DirectWorkerClientDeps[K]
    >>;
  }

  async open(
    narrative: string,
    intent: string,
    opts?: {
      codePath?: string;
      resolveDangling?: ResolveDangling;
      targets?: NarrativeTarget[];
      fromResultId?: string;
    },
  ) {
    return this.call("open", [narrative, intent, opts]);
  }

  async write(...args: Parameters<DirectWorkerClientDeps["write"]>) {
    return this.call("write", args);
  }

  async log(...args: Parameters<DirectWorkerClientDeps["log"]>) {
    return this.call("log", args);
  }

  async designateJournalEntry(...args: Parameters<DirectWorkerClientDeps["designateJournalEntry"]>) {
    return this.call("designateJournalEntry", args);
  }

  async ask(...args: Parameters<DirectWorkerClientDeps["ask"]>) {
    return this.call("ask", args);
  }

  async query(...args: Parameters<DirectWorkerClientDeps["query"]>) {
    return this.call("query", args);
  }

  async close(...args: Parameters<DirectWorkerClientDeps["close"]>) {
    return this.call("close", args);
  }

  async listJobs(opts?: { codePath?: string; limit?: number; type?: LoreJobType }) {
    if (!this.useDaemon("listJobs")) {
      const closeJobs = await this.callDirect("listCloseJobs", [{ codePath: opts?.codePath, limit: opts?.limit }]);
      return closeJobs.map((job) => ({
        id: job.id,
        code_path: opts?.codePath ?? process.cwd(),
        type: "close" as LoreJobType,
        subject: job.narrative_name,
        status: job.status,
        owner: job.owner,
        attempt: job.attempt,
        lease_expires_at: job.lease_expires_at,
        last_error: job.last_error,
        created_at: job.created_at,
        updated_at: job.updated_at,
        completed_at: job.completed_at,
      }));
    }
    return (await this.daemon.listJobs(opts)) as LoreJob[];
  }

  async getJobDetail(jobId: string, opts?: { codePath?: string }) {
    if (!this.useDaemon("getJobDetail")) {
      const detail = await this.callDirect("getCloseJobDetail", [jobId, opts]);
      return {
        job: {
          id: detail.job.id,
          code_path: opts?.codePath ?? process.cwd(),
          type: "close" as LoreJobType,
          subject: detail.job.narrative_name,
          status: detail.job.status,
          owner: detail.job.owner,
          attempt: detail.job.attempt,
          lease_expires_at: detail.job.lease_expires_at,
          last_error: detail.job.last_error,
          created_at: detail.job.created_at,
          updated_at: detail.job.updated_at,
          completed_at: detail.job.completed_at,
        },
        result: detail.result ?? null,
      } satisfies LoreJobDetail;
    }
    return this.daemon.getJobDetail(jobId, opts);
  }

  async waitForJob(jobId: string, opts?: { codePath?: string; pollMs?: number }) {
    if (!this.useDaemon("waitForJob")) {
      const result = await this.callDirect("waitForCloseJob", [jobId, opts]);
      return {
        job: ((result.close_job as unknown as LoreJob) ?? {
          id: jobId,
          code_path: opts?.codePath ?? process.cwd(),
          type: "close",
          subject: result.close_job?.narrative_name ?? "close",
          status: "done",
          owner: null,
          attempt: 1,
          lease_expires_at: null,
          last_error: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          completed_at: new Date().toISOString(),
        } as LoreJob),
        result,
      } satisfies LoreJobDetail;
    }
    return this.daemon.waitForJob(jobId, opts);
  }

  async listCloseJobs(opts?: { codePath?: string; limit?: number }): Promise<CloseJob[]> {
    if (!this.useDaemon("listJobs")) {
      return this.callDirect("listCloseJobs", [opts]);
    }
    const jobs = await this.daemon.listJobs({ ...opts, type: "close" });
    return jobs.map(toLegacyCloseJob);
  }

  async getCloseJobDetail(jobId: string, opts?: { codePath?: string }): Promise<CloseJobDetail> {
    if (!this.useDaemon("getJobDetail")) {
      return this.callDirect("getCloseJobDetail", [jobId, opts]);
    }
    const detail = await this.daemon.getJobDetail(jobId, opts);
    if (detail.job.type !== "close") {
      throw new Error(`Job '${jobId}' is not a close job`);
    }
    return {
      job: toLegacyCloseJob(detail.job),
      result: (detail.result as CloseResult | null | undefined) ?? null,
    };
  }

  async waitForCloseJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<CloseResult> {
    if (!this.useDaemon("waitForJob")) {
      return this.callDirect("waitForCloseJob", [jobId, opts]);
    }
    const detail = await this.daemon.waitForJob(jobId, opts);
    if (detail.job.type !== "close") {
      throw new Error(`Job '${jobId}' is not a close job`);
    }
    return asCloseResult(detail);
  }

  async runCloseWorker(opts?: {
    codePath?: string;
    watch?: boolean;
    pollMs?: number;
  }): Promise<CloseWorkerRunResult> {
    if (!this.useDaemon("runCloseWorker")) {
      return this.callDirect("runCloseWorker", [opts]);
    }
    const result = await this.daemon.runCloseWorker(opts);
    return {
      mode: result.mode,
      close_jobs_processed: result.jobs_processed_by_type.close,
      close_jobs_failed: result.jobs_failed_by_type.close,
      maintenance_jobs_processed: 0,
      maintenance_jobs_failed: 0,
      idle_polls: result.idle_polls,
      last_job_id: result.last_job_id,
    };
  }

  async status(...args: Parameters<DirectWorkerClientDeps["status"]>) {
    return this.call("status", args);
  }

  async ls(...args: Parameters<DirectWorkerClientDeps["ls"]>) {
    return this.call("ls", args);
  }

  async show(...args: Parameters<DirectWorkerClientDeps["show"]>) {
    return this.call("show", args);
  }

  async history(...args: Parameters<DirectWorkerClientDeps["history"]>) {
    return this.call("history", args);
  }

  async showNarrativeTrail(...args: Parameters<DirectWorkerClientDeps["showNarrativeTrail"]>) {
    return this.call("showNarrativeTrail", args);
  }

  async diff(...args: Parameters<DirectWorkerClientDeps["diff"]>) {
    return this.call("diff", args);
  }

  async diffCommits(...args: Parameters<DirectWorkerClientDeps["diffCommits"]>) {
    return this.call("diffCommits", args);
  }

  async conceptRename(...args: Parameters<DirectWorkerClientDeps["conceptRename"]>) {
    return this.call("conceptRename", args);
  }

  async conceptArchive(...args: Parameters<DirectWorkerClientDeps["conceptArchive"]>) {
    return this.call("conceptArchive", args);
  }

  async conceptRestore(...args: Parameters<DirectWorkerClientDeps["conceptRestore"]>) {
    return this.call("conceptRestore", args);
  }

  async conceptMerge(...args: Parameters<DirectWorkerClientDeps["conceptMerge"]>) {
    return this.call("conceptMerge", args);
  }

  async conceptSplit(...args: Parameters<DirectWorkerClientDeps["conceptSplit"]>) {
    return this.call("conceptSplit", args);
  }

  async conceptPatch(...args: Parameters<DirectWorkerClientDeps["conceptPatch"]>) {
    return this.call("conceptPatch", args);
  }

  async setConceptRelation(...args: Parameters<DirectWorkerClientDeps["setConceptRelation"]>) {
    return this.call("setConceptRelation", args);
  }

  async unsetConceptRelation(...args: Parameters<DirectWorkerClientDeps["unsetConceptRelation"]>) {
    return this.call("unsetConceptRelation", args);
  }

  async listConceptRelations(...args: Parameters<DirectWorkerClientDeps["listConceptRelations"]>) {
    return this.call("listConceptRelations", args);
  }

  async tagConcept(...args: Parameters<DirectWorkerClientDeps["tagConcept"]>) {
    return this.call("tagConcept", args);
  }

  async untagConcept(...args: Parameters<DirectWorkerClientDeps["untagConcept"]>) {
    return this.call("untagConcept", args);
  }

  async listConceptTags(...args: Parameters<DirectWorkerClientDeps["listConceptTags"]>) {
    return this.call("listConceptTags", args);
  }

  async computeConceptHealth(...args: Parameters<DirectWorkerClientDeps["computeConceptHealth"]>) {
    return this.call("computeConceptHealth", args);
  }

  async explainConceptHealth(...args: Parameters<DirectWorkerClientDeps["explainConceptHealth"]>) {
    return this.call("explainConceptHealth", args);
  }

  async healConcepts(...args: Parameters<DirectWorkerClientDeps["healConcepts"]>) {
    return this.call("healConcepts", args);
  }

  async rebuild(...args: Parameters<DirectWorkerClientDeps["rebuild"]>) {
    if (this.useDaemon("rebuild")) {
      return (await this.daemon.call("rebuild", [args[0] ?? {}])) as RebuildResult;
    }
    return this.callDirect("rebuild", args);
  }

  async refreshEmbeddings(...args: Parameters<DirectWorkerClientDeps["refreshEmbeddings"]>) {
    return this.call("refreshEmbeddings", args);
  }

  async reEmbed(...args: Parameters<DirectWorkerClientDeps["reEmbed"]>) {
    return this.call("reEmbed", args);
  }

  async dryRunClose(...args: Parameters<DirectWorkerClientDeps["dryRunClose"]>) {
    return this.call("dryRunClose", args);
  }

  async commitLog(...args: Parameters<DirectWorkerClientDeps["commitLog"]>) {
    return this.call("commitLog", args);
  }

  async resetLoreMind(...args: Parameters<DirectWorkerClientDeps["resetLoreMind"]>) {
    return this.call("resetLoreMind", args);
  }

  async getLoreMindConfig(...args: Parameters<DirectWorkerClientDeps["getLoreMindConfig"]>) {
    return this.call("getLoreMindConfig", args);
  }

  async setLoreMindConfig(...args: Parameters<DirectWorkerClientDeps["setLoreMindConfig"]>) {
    return this.call("setLoreMindConfig", args);
  }

  async unsetLoreMindConfig(...args: Parameters<DirectWorkerClientDeps["unsetLoreMindConfig"]>) {
    return this.call("unsetLoreMindConfig", args);
  }

  async cloneLoreMindConfig(...args: Parameters<DirectWorkerClientDeps["cloneLoreMindConfig"]>) {
    return this.call("cloneLoreMindConfig", args);
  }

  async getPromptPreview(...args: Parameters<DirectWorkerClientDeps["getPromptPreview"]>) {
    return this.call("getPromptPreview", args);
  }

  async suggest(...args: Parameters<DirectWorkerClientDeps["suggest"]>) {
    return this.call("suggest", args);
  }

  async conceptBindings(...args: Parameters<DirectWorkerClientDeps["conceptBindings"]>) {
    return this.call("conceptBindings", args);
  }

  async bindSymbol(...args: Parameters<DirectWorkerClientDeps["bindSymbol"]>) {
    return this.call("bindSymbol", args);
  }

  async unbindSymbol(...args: Parameters<DirectWorkerClientDeps["unbindSymbol"]>) {
    return this.call("unbindSymbol", args);
  }

  async symbolDrift(...args: Parameters<DirectWorkerClientDeps["symbolDrift"]>) {
    return this.call("symbolDrift", args);
  }

  async rebindAll(...args: Parameters<DirectWorkerClientDeps["rebindAll"]>) {
    return this.call("rebindAll", args);
  }

  async rescan(...args: Parameters<DirectWorkerClientDeps["rescan"]>) {
    return this.call("rescan", args);
  }

  async ingestDoc(...args: Parameters<DirectWorkerClientDeps["ingestDoc"]>) {
    if (this.useDaemon("ingestDoc")) {
      return (await this.daemon.call("ingestDoc", [args[0], { ...(args[1] ?? {}), wait: true }])) as IngestResult;
    }
    return this.callDirect("ingestDoc", args);
  }

  async ingestAll(...args: Parameters<DirectWorkerClientDeps["ingestAll"]>) {
    if (this.useDaemon("ingestAll")) {
      return (await this.daemon.call("ingestAll", [{ ...(args[0] ?? {}), wait: true }])) as {
        scan: ScanResult;
        ingest: IngestResult;
      };
    }
    return this.callDirect("ingestAll", args);
  }

  async autoBind(...args: Parameters<DirectWorkerClientDeps["autoBind"]>) {
    return this.call("autoBind", args);
  }

  async symbolSearch(...args: Parameters<DirectWorkerClientDeps["symbolSearch"]>) {
    return this.call("symbolSearch", args);
  }

  async fileSymbols(...args: Parameters<DirectWorkerClientDeps["fileSymbols"]>) {
    return this.call("fileSymbols", args);
  }

  async scanStats(...args: Parameters<DirectWorkerClientDeps["scanStats"]>) {
    return this.call("scanStats", args);
  }

  async coverageReport(...args: Parameters<DirectWorkerClientDeps["coverageReport"]>) {
    return this.call("coverageReport", args);
  }

  async bootstrapPlan(...args: Parameters<DirectWorkerClientDeps["bootstrapPlan"]>) {
    return this.call("bootstrapPlan", args);
  }

  async recall(...args: Parameters<DirectWorkerClientDeps["recall"]>) {
    return this.call("recall", args);
  }

  async scoreResult(...args: Parameters<DirectWorkerClientDeps["scoreResult"]>) {
    return this.call("scoreResult", args);
  }

  async register(...args: Parameters<DirectWorkerClientDeps["register"]>) {
    return this.call("register", args);
  }

  async migrate(...args: Parameters<DirectWorkerClientDeps["migrate"]>) {
    return this.call("migrate", args);
  }

  async migrateStatus(...args: Parameters<DirectWorkerClientDeps["migrateStatus"]>) {
    return this.call("migrateStatus", args);
  }

  async repair(...args: Parameters<DirectWorkerClientDeps["repair"]>) {
    return this.call("repair", args);
  }

  async listLoreMinds(...args: Parameters<DirectWorkerClientDeps["listLoreMinds"]>) {
    return this.call("listLoreMinds", args);
  }

  async removeLoreMind(...args: Parameters<DirectWorkerClientDeps["removeLoreMind"]>) {
    return this.call("removeLoreMind", args);
  }

  async listProviderCredentials(...args: Parameters<DirectWorkerClientDeps["listProviderCredentials"]>) {
    return this.call("listProviderCredentials", args);
  }

  async getProviderCredential(...args: Parameters<DirectWorkerClientDeps["getProviderCredential"]>) {
    return this.call("getProviderCredential", args);
  }

  async setProviderCredential(...args: Parameters<DirectWorkerClientDeps["setProviderCredential"]>) {
    return this.call("setProviderCredential", args);
  }

  async unsetProviderCredential(...args: Parameters<DirectWorkerClientDeps["unsetProviderCredential"]>) {
    return this.call("unsetProviderCredential", args);
  }
}

export function createWorkerClient(options?: WorkerClientOptions): WorkerClient {
  return new WorkerClient(options);
}

export async function serveLoreDaemon(opts?: {
  socket?: string;
  db?: string;
  log?: string;
}): Promise<void> {
  const paths = getLoreDaemonPaths();
  await runLoreDaemonServer({
    ...paths,
    socketPath: opts?.socket ?? paths.socketPath,
    dbPath: opts?.db ?? paths.dbPath,
    logPath: opts?.log ?? paths.logPath,
  });
}
