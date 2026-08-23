import { chmodSync, appendFileSync, rmSync } from "fs";
import { randomUUID } from "crypto";
import { createServer, Socket } from "net";
import { resolve } from "path";
import {
  LoreError,
  createLoreClient,
  type CloseResult,
  type IngestResult,
  type MergeStrategy,
  type RebuildResult,
  type StatusResult,
} from "@lore/sdk";
import {
  claimDaemonJob,
  completeDaemonJob,
  failDaemonJob,
  getDaemonJob,
  getDaemonJobCounts,
  getLatestPendingDaemonJob,
  getRawDaemonJob,
  listActiveJobCodePaths,
  listDaemonJobs,
  openDaemonQueueDb,
  queueDaemonJob,
} from "./daemon-db.ts";
import {
  acquireLoreLock,
  ensureLoreDaemonDir,
  loreDaemonLockPath,
  releaseLoreLock,
  removeLoreDaemonState,
  writeLoreDaemonState,
  type LoreDaemonPaths,
} from "./daemon-paths.ts";
import type {
  DaemonRequest,
  DaemonResponse,
  LoreDaemonRunResult,
  LoreDaemonStatus,
  LoreJob,
  LoreJobDetail,
  LoreJobType,
  QueuedCloseResult,
  SerializedDaemonError,
} from "./daemon-protocol.ts";

/** The server-handled methods also accept a trailing/leading options object
 *  that must receive the caller's cwd as codePath — the proxy table above
 *  covers only SDK-proxied methods. */
const SERVER_HANDLED_INJECT: Record<string, { inject: number | "last" }> = {
  status: { inject: 0 },
  close: { inject: 1 },
  ingestDoc: { inject: 1 },
  ingestAll: { inject: 0 },
  rebuild: { inject: 0 },
  listJobs: { inject: 0 },
  getJobDetail: { inject: 1 },
  waitForJob: { inject: 1 },
  runCloseWorker: { inject: 0 },
};

type DirectClient = ReturnType<typeof createLoreClient>;

/** Methods the server implements itself instead of proxying to @lore/sdk. */
type ServerHandledClientMethod =
  | "shutdown"
  | "status"
  | "close"
  | "ingestDoc"
  | "ingestAll"
  | "rebuild"
  | "runCloseWorker";

/**
 * Argument contract for every proxied SDK method. One table replaces the
 * three hand-maintained lists it used to live behind (concurrency set,
 * routing switch, cwd-injection switch) which desynced from the SDK one
 * signature at a time:
 *
 * - `maxArgs`   — reject calls carrying more arguments than the client
 *                 method accepts (defensive bound on socket input).
 * - `inject`    — index of the options object that receives the caller's
 *                 cwd as `codePath` when absent ("last" = variadic tail,
 *                 appended when missing). Omitted = no injection.
 * - `concurrent`— pure reads that may bypass the per-mind write chain;
 *                 their only writes are single-statement inserts.
 *
 * The `satisfies` clause makes this a compile-time contract: a method added
 * to the SDK client must be classified here (or added to
 * ServerHandledClientMethod) or the worker package stops compiling.
 */
/** Default cap on how long a caller may block inside the daemon waiting for
 *  a job. Long LLM closes are normal; forever is not. Override per call with
 *  `timeoutMs`, or globally with LORE_JOB_WAIT_TIMEOUT_MS (0 disables). */
export const DEFAULT_JOB_WAIT_TIMEOUT_MS = 15 * 60_000;

interface ProxyMethodSpec {
  maxArgs: number;
  inject?: number | "last";
  concurrent?: true;
}

const PROXY_METHODS = {
  register: { maxArgs: 2 },
  open: { maxArgs: 3, inject: 2 },
  write: { maxArgs: 3, inject: 2 },
  log: { maxArgs: 3, inject: 2 },
  designateJournalEntry: { maxArgs: 3, inject: 2 },
  ask: { maxArgs: 2, inject: 1, concurrent: true },
  query: { maxArgs: 2, inject: 1, concurrent: true },
  queryForOrchestration: { maxArgs: 2 },
  searchWeb: { maxArgs: 2 },
  summarizeMatches: { maxArgs: 3 },
  listCloseJobs: { maxArgs: 1 },
  getCloseJobDetail: { maxArgs: 2 },
  waitForCloseJob: { maxArgs: 2 },
  healthSnapshot: { maxArgs: 1 },
  ls: { maxArgs: 1 },
  show: { maxArgs: 2, inject: 1, concurrent: true },
  history: { maxArgs: 2 },
  showNarrativeTrail: { maxArgs: 2, inject: 1, concurrent: true },
  diff: { maxArgs: 3 },
  diffCommits: { maxArgs: 3 },
  conceptRename: { maxArgs: 3, inject: 2 },
  conceptArchive: { maxArgs: 2, inject: 1 },
  conceptRestore: { maxArgs: 2, inject: 1 },
  conceptMerge: { maxArgs: 3, inject: 2 },
  conceptSplit: { maxArgs: 2, inject: 1 },
  conceptPatch: { maxArgs: 3, inject: 2 },
  setConceptRelation: { maxArgs: 4, inject: 3 },
  unsetConceptRelation: { maxArgs: 3, inject: 2 },
  listConceptRelations: { maxArgs: 1 },
  tagConcept: { maxArgs: 3, inject: 2 },
  untagConcept: { maxArgs: 3, inject: 2 },
  listConceptTags: { maxArgs: 1 },
  computeConceptHealth: { maxArgs: 1, inject: 0 },
  explainConceptHealth: { maxArgs: 2, inject: 1 },
  healConcepts: { maxArgs: 1, inject: 0 },
  refreshEmbeddings: { maxArgs: 1, inject: 0 },
  reEmbed: { maxArgs: 1, inject: 0 },
  dryRunClose: { maxArgs: 2 },
  migrate: { maxArgs: 1, inject: "last" },
  migrateStatus: { maxArgs: 1, inject: "last" },
  repair: { maxArgs: 1, inject: "last" },
  commitLog: { maxArgs: 1 },
  listLoreMinds: { maxArgs: 0 },
  removeLoreMind: { maxArgs: 2 },
  resetLoreMind: { maxArgs: 1, inject: "last" },
  listProviderCredentials: { maxArgs: 0 },
  getProviderCredential: { maxArgs: 1 },
  setProviderCredential: { maxArgs: 2 },
  unsetProviderCredential: { maxArgs: 2 },
  getLoreMindConfig: { maxArgs: 1 },
  setLoreMindConfig: { maxArgs: 3, inject: 2 },
  unsetLoreMindConfig: { maxArgs: 2, inject: 1 },
  cloneLoreMindConfig: { maxArgs: 2, inject: 1 },
  getPromptPreview: { maxArgs: 2 },
  suggest: { maxArgs: 1 },
  conceptBindings: { maxArgs: 2 },
  bindSymbol: { maxArgs: 3, inject: 2 },
  unbindSymbol: { maxArgs: 3, inject: 2 },
  symbolDrift: { maxArgs: 1 },
  rebindAll: { maxArgs: 1, inject: 0 },
  rescan: { maxArgs: 1, inject: 0 },
  autoBind: { maxArgs: 1, inject: 0 },
  symbolSearch: { maxArgs: 2 },
  fileSymbols: { maxArgs: 2 },
  scanStats: { maxArgs: 1 },
  coverageReport: { maxArgs: 1 },
  bootstrapPlan: { maxArgs: 1 },
  recall: { maxArgs: 2, inject: 1, concurrent: true },
  scoreResult: { maxArgs: 3, inject: 2 },
  kpiLog: { maxArgs: 3, inject: 2 },
  kpiGoal: { maxArgs: 3, inject: 2 },
  kpiStatus: { maxArgs: 1, inject: 0 },
} as const satisfies Record<
  Exclude<keyof DirectClient, ServerHandledClientMethod>,
  ProxyMethodSpec
>;

type ProxyMethod = keyof typeof PROXY_METHODS;

/** Merge the caller's cwd into the options object at `index` unless it
 *  already carries an explicit codePath. No cwd → leave args untouched. */
function applyCallerCodePath(
  spec: ProxyMethodSpec | { inject: number | "last" },
  args: unknown[],
  fallbackCwd?: string,
): unknown[] {
  const codePath = fallbackCwd ? resolve(fallbackCwd) : undefined;
  if (!codePath || spec.inject === undefined) return args;
  const withCodePath = <T extends Record<string, unknown> | undefined>(value: T): T | { codePath: string } => {
    if (!value) return { codePath };
    if ("codePath" in value && typeof value.codePath === "string") return value;
    return { ...value, codePath };
  };
  if (spec.inject === "last") {
    // Variadic tail (migrate/repair family): append options when absent.
    return args.length === 0
      ? [withCodePath(undefined)]
      : [...args.slice(0, -1), withCodePath(args.at(-1) as Record<string, unknown> | undefined)];
  }
  const next = [...args];
  next[spec.inject] = withCodePath(next[spec.inject] as Record<string, unknown> | undefined);
  return next;
}

/** Routing key source for serialization: explicit string codePath argument
 *  (register) else the trailing options object, else the caller's cwd. */
function routeCodePathFor(method: ProxyMethod, args: unknown[], fallbackCwd?: string): string | undefined {
  if (method === "register") {
    return typeof args[0] === "string" ? (args[0] as string) : fallbackCwd;
  }
  return getCodePathFromOptions(args.at(-1)) ?? fallbackCwd;
}

interface CloseJobPayload {
  narrative: string;
  opts?: {
    codePath?: string;
    mergeStrategy?: MergeStrategy;
    fromResultId?: string;
    pollMs?: number;
    wait?: boolean;
  };
}

interface IngestJobPayload {
  filePath?: string;
  wait?: boolean;
  force?: boolean;
}

interface RebuildJobPayload {
  wait?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function routeKeyForCodePath(codePath: string | null | undefined): string {
  return codePath ? resolve(codePath) : "__global__";
}

function serializeError(error: unknown): SerializedDaemonError {
  if (error instanceof LoreError) {
    return {
      code: error.code,
      message: error.message,
      details: error.details ?? null,
      name: error.name,
    };
  }
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
    };
  }
  return {
    message: String(error),
  };
}

function legacyCloseJobFromJob(job: LoreJob) {
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

function buildQueuedCloseResult(job: LoreJob): QueuedCloseResult {
  return {
    mode: "merge",
    integrated: false,
    commit_id: null,
    narrative_status: "closing",
    concepts_updated: [],
    concepts_created: [],
    conflicts: [],
    impact: {
      summary: "Queued background close job",
      debt_before: null,
      debt_after: null,
    },
    maintenance: {
      status: "queued",
      pending_jobs: 1,
      failed_jobs: 0,
      note: `Use lore wait ${job.id} to block for completion`,
    },
    close_job: legacyCloseJobFromJob(job),
  };
}

function looksLikeCloseResult(value: unknown): value is CloseResult {
  if (!value || typeof value !== "object") return false;
  return "integrated" in value && "impact" in value && "mode" in value;
}

function getCodePathFromOptions(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  return typeof (value as { codePath?: unknown }).codePath === "string"
    ? ((value as { codePath?: string }).codePath as string)
    : undefined;
}

export class LoreDaemonServer {
  private client!: DirectClient;
  private readonly paths: LoreDaemonPaths;
  private queueDb!: ReturnType<typeof openDaemonQueueDb>;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly activeProcessors = new Set<string>();
  private readonly startedAt = new Date().toISOString();
  private server = createServer((socket) => {
    void this.handleSocket(socket);
  });
  private shuttingDown = false;

  constructor(paths: LoreDaemonPaths) {
    this.paths = ensureLoreDaemonDir(paths);
  }

  async run(): Promise<void> {
    ensureLoreDaemonDir(this.paths);
    // The queue DB, the socket unlink, and the bind all happen under this lock.
    // A second daemon reaching here would otherwise unlink a *live* daemon's
    // socket and bind its own, orphaning every client already connected.
    if (!acquireLoreLock(loreDaemonLockPath(this.paths))) {
      this.log("another daemon holds the lock; exiting without binding");
      return;
    }
    try {
      this.queueDb = openDaemonQueueDb(this.paths.dbPath);
      this.client = createLoreClient();
      rmSync(this.paths.socketPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        this.server.once("error", reject);
        this.server.listen(this.paths.socketPath, () => {
          this.server.off("error", reject);
          resolve();
        });
      });
    } catch (error) {
      releaseLoreLock(loreDaemonLockPath(this.paths));
      throw error;
    }
    try {
      chmodSync(this.paths.socketPath, 0o600);
    } catch {}
    writeLoreDaemonState(
      {
        pid: process.pid,
        socket_path: this.paths.socketPath,
        db_path: this.paths.dbPath,
        log_path: this.paths.logPath,
        started_at: this.startedAt,
      },
      this.paths,
    );
    this.log(`daemon listening on ${this.paths.socketPath}`);
    process.on("SIGINT", () => {
      void this.stop();
    });
    process.on("SIGTERM", () => {
      void this.stop();
    });
    for (const codePath of listActiveJobCodePaths(this.queueDb)) {
      this.scheduleProcessing(codePath);
    }
    await new Promise<void>((resolve) => {
      this.server.once("close", () => resolve());
    });
  }

  private async stop(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    this.log("daemon shutting down");
    await new Promise<void>((resolve) => {
      this.server.close(() => resolve());
    });
    try {
      rmSync(this.paths.socketPath, { force: true });
    } catch {}
    removeLoreDaemonState(this.paths);
    releaseLoreLock(loreDaemonLockPath(this.paths));
    this.queueDb.close();
    this.client.shutdown();
  }

  private log(message: string): void {
    appendFileSync(
      this.paths.logPath,
      `${new Date().toISOString()} [pid:${process.pid}] ${message}\n`,
      "utf-8",
    );
  }

  private async handleSocket(socket: Socket): Promise<void> {
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      // Newline framing with remainder retention: bytes after the last
      // complete request stay buffered instead of being discarded, so
      // requests written back-to-back are each answered in order.
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const raw = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf("\n");
        void this.respond(socket, raw);
      }
    });
    socket.on("error", () => {
      socket.destroy();
    });
  }

  private async respond(socket: Socket, raw: string): Promise<void> {
    let request: DaemonRequest | null = null;
    try {
      request = JSON.parse(raw) as DaemonRequest;
      const result = await this.dispatch(request);
      const response: DaemonResponse = {
        id: request.id,
        ok: true,
        result,
      };
      if (!socket.write(`${JSON.stringify(response)}\n`)) {
        await new Promise<void>((resolve) => socket.once("drain", resolve));
      }
    } catch (error) {
      const response: DaemonResponse = {
        id: request?.id ?? randomUUID(),
        ok: false,
        error: serializeError(error),
      };
      // A malformed frame desyncs the stream — answer and hang up.
      socket.end(`${JSON.stringify(response)}\n`);
    }
  }

  private async dispatch(request: DaemonRequest): Promise<unknown> {
    const args = this.withCallerCodePath(request.method, request.args, request.cwd);
    switch (request.method) {
      case "ping":
        return { ok: true, pid: process.pid };
      case "daemonStatus":
        return this.getDaemonStatus();
      case "stopDaemon":
        setTimeout(() => {
          void this.stop();
        }, 10);
        return { stopped: true };
      case "listJobs":
        return listDaemonJobs(this.queueDb, args[0] as {
          codePath?: string;
          limit?: number;
          type?: LoreJobType;
        });
      case "getJobDetail":
        return this.getJobDetail(
          args[0] as string,
          args[1] as { codePath?: string } | undefined,
        );
      case "waitForJob":
        return this.waitForJob(
          args[0] as string,
          args[1] as { codePath?: string; pollMs?: number; timeoutMs?: number } | undefined,
        );
      case "runCloseWorker":
        return this.processJobsForCodePath(
          routeKeyForCodePath(getCodePathFromOptions(args.at(-1)) ?? request.cwd),
          {
            mode: (args[0] as { watch?: boolean } | undefined)?.watch ? "watch" : "once",
            pollMs: (args[0] as { pollMs?: number } | undefined)?.pollMs,
            type: "close",
          },
        );
      case "close":
        return this.handleClose(
          args[0] as string,
          args[1] as CloseJobPayload["opts"] & {
            mode?: "merge" | "discard";
            wait?: boolean;
          },
        );
      case "ingestDoc":
        return this.handleIngestDoc(
          args[0] as string,
          args[1] as { codePath?: string; wait?: boolean } | undefined,
        );
      case "ingestAll":
        return this.handleIngestAll(
          args[0] as { codePath?: string; wait?: boolean; force?: boolean } | undefined,
        );
      case "rebuild":
        return this.handleRebuild(
          args[0] as { codePath?: string; wait?: boolean } | undefined,
        );
      case "status":
        return this.handleStatus(
          args[0] as { codePath?: string } | undefined,
        );
      default: {
        const methodName = request.method;
        // hasOwnProperty, not `in`: "constructor"/"toString" must not match
        // through the prototype chain.
        const spec: ProxyMethodSpec | undefined = Object.hasOwn(PROXY_METHODS, methodName)
          ? PROXY_METHODS[methodName as ProxyMethod]
          : undefined;
        if (!spec) {
          throw new Error(`Unknown daemon method '${methodName}'`);
        }
        if (Array.isArray(args) && args.length > spec.maxArgs) {
          throw new Error(
            `Daemon method '${request.method}' accepts at most ${spec.maxArgs} argument(s), got ${args.length}`,
          );
        }
        const invoke = async () => {
          // Allowlist-checked above; this cast only bridges the SDK's
          // heterogeneous method signatures.
          const fn = this.client[request.method as keyof DirectClient] as
            | ((...callArgs: unknown[]) => unknown)
            | undefined;
          if (typeof fn !== "function") {
            throw new Error(`Unknown daemon method '${request.method}'`);
          }
          return await fn.apply(this.client, args);
        };
        // Read-path methods run concurrently — the per-mind chain exists to keep
        // multi-step mutations (open/write/close/merge/rebuild) from interleaving,
        // and was serializing every ask behind every other ask.
        if (spec.concurrent) {
          return invoke();
        }
        const codePath = routeCodePathFor(
          request.method as ProxyMethod,
          args,
          request.cwd,
        );
        return this.runSerialized(routeKeyForCodePath(codePath), invoke);
      }
    }
  }

  private withCallerCodePath(method: string, args: unknown[], cwd?: string): unknown[] {
    const spec = Object.hasOwn(PROXY_METHODS, method)
      ? PROXY_METHODS[method as ProxyMethod]
      : SERVER_HANDLED_INJECT[method];
    if (!spec) return args;
    return applyCallerCodePath(spec, args, cwd);
  }

  private getDaemonStatus(): LoreDaemonStatus {
    const counts = getDaemonJobCounts(this.queueDb);
    return {
      running: true,
      pid: process.pid,
      socket_path: this.paths.socketPath,
      db_path: this.paths.dbPath,
      log_path: this.paths.logPath,
      started_at: this.startedAt,
      queued_jobs: counts.queued,
      leased_jobs: counts.leased,
      failed_jobs: counts.failed,
      done_jobs: counts.done,
      active_lores: listActiveJobCodePaths(this.queueDb),
    };
  }

  private async handleStatus(opts?: { codePath?: string }): Promise<StatusResult> {
    const key = routeKeyForCodePath(opts?.codePath);
    return this.runSerialized(key, async () => {
      const result = await this.client.status(opts);
      const counts = getDaemonJobCounts(this.queueDb, { codePath: key });
      result.maintenance.pending_close_jobs = counts.queued + counts.leased;
      result.maintenance.failed_close_jobs = counts.failed;
      return result;
    });
  }

  private async handleClose(
    narrative: string,
    opts?: CloseJobPayload["opts"] & { mode?: "merge" | "discard"; wait?: boolean },
  ): Promise<CloseResult> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    if ((opts?.mode ?? "merge") === "discard") {
      return this.runSerialized(codePath, async () => {
        return await this.client.close(narrative, opts);
      });
    }
    const existing = getLatestPendingDaemonJob(this.queueDb, {
      codePath,
      type: "close",
      subject: narrative,
    });
    const job =
      existing ??
      queueDaemonJob(this.queueDb, {
        codePath,
        type: "close",
        subject: narrative,
        payload: {
          narrative,
          opts: { ...opts, codePath, wait: undefined },
        } satisfies CloseJobPayload,
      });
    this.scheduleProcessing(codePath);
    if (opts?.wait) {
      const waited = await this.waitForJob(job.id, { codePath, pollMs: opts.pollMs });
      if (looksLikeCloseResult(waited.result)) {
        return {
          ...waited.result,
          close_job: legacyCloseJobFromJob(waited.job),
        };
      }
      throw new LoreError("CLOSE_JOB_FAILED", `Close job '${job.id}' did not produce a close result`);
    }
    return buildQueuedCloseResult(job);
  }

  private async handleIngestDoc(
    filePath: string,
    opts?: { codePath?: string; wait?: boolean },
  ): Promise<IngestResult | LoreJobDetail> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    const subject = `file:${filePath}`;
    const existing = getLatestPendingDaemonJob(this.queueDb, {
      codePath,
      type: "ingest",
      subject,
    });
    const job =
      existing ??
      queueDaemonJob(this.queueDb, {
        codePath,
        type: "ingest",
        subject,
        payload: {
          filePath,
          wait: opts?.wait ?? true,
        } satisfies IngestJobPayload,
      });
    this.scheduleProcessing(codePath);
    if (opts?.wait === false) {
      return { job, result: null };
    }
    const detail = await this.waitForJob(job.id, { codePath });
    return detail.result as IngestResult;
  }

  private async handleIngestAll(
    opts?: { codePath?: string; wait?: boolean; force?: boolean },
  ): Promise<{ scan: unknown; ingest: IngestResult } | LoreJobDetail> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    const existing = getLatestPendingDaemonJob(this.queueDb, {
      codePath,
      type: "ingest",
      subject: "all",
    });
    const job =
      existing ??
      queueDaemonJob(this.queueDb, {
        codePath,
        type: "ingest",
        subject: "all",
        payload: {
          wait: opts?.wait ?? true,
          force: opts?.force,
        } satisfies IngestJobPayload,
      });
    this.scheduleProcessing(codePath);
    if (opts?.wait === false) {
      return { job, result: null };
    }
    const detail = await this.waitForJob(job.id, { codePath });
    return detail.result as { scan: unknown; ingest: IngestResult };
  }

  private async handleRebuild(
    opts?: { codePath?: string; wait?: boolean },
  ): Promise<RebuildResult | LoreJobDetail> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    const existing = getLatestPendingDaemonJob(this.queueDb, {
      codePath,
      type: "rebuild",
      subject: "full",
    });
    const job =
      existing ??
      queueDaemonJob(this.queueDb, {
        codePath,
        type: "rebuild",
        subject: "full",
        payload: {
          wait: opts?.wait ?? true,
        } satisfies RebuildJobPayload,
      });
    this.scheduleProcessing(codePath);
    if (opts?.wait === false) {
      return { job, result: null };
    }
    const detail = await this.waitForJob(job.id, { codePath });
    return detail.result as RebuildResult;
  }

  private async getJobDetail(jobId: string, opts?: { codePath?: string }): Promise<LoreJobDetail> {
    const detail = getDaemonJob(this.queueDb, { id: jobId, codePath: opts?.codePath });
    if (!detail) {
      throw new Error(`No daemon job '${jobId}' was found`);
    }
    return detail;
  }

  private async waitForJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number; timeoutMs?: number },
  ): Promise<LoreJobDetail> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    const timeoutMs =
      opts?.timeoutMs ??
      (process.env.LORE_JOB_WAIT_TIMEOUT_MS
        ? Number(process.env.LORE_JOB_WAIT_TIMEOUT_MS)
        : DEFAULT_JOB_WAIT_TIMEOUT_MS);
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : null;
    while (true) {
      const detail = await this.getJobDetail(jobId, { codePath });
      if (detail.job.status === "done") return detail;
      if (detail.job.status === "failed") {
        throw new Error(detail.job.last_error ?? `Daemon job '${jobId}' failed`);
      }
      if (deadline != null && Date.now() > deadline) {
        throw new LoreError(
          "JOB_WAIT_TIMEOUT",
          `Timed out waiting for daemon job '${jobId}' after ${Math.round(timeoutMs / 1000)}s ` +
            `(status: ${detail.job.status}); it may still be running — check 'lore jobs'`,
        );
      }
      this.scheduleProcessing(codePath);
      await sleep(Math.max(50, opts?.pollMs ?? 250));
    }
  }

  private scheduleProcessing(codePath: string): void {
    if (this.activeProcessors.has(codePath)) return;
    this.activeProcessors.add(codePath);
    void this.runSerialized(codePath, async () => {
      try {
        await this.processJobLoop(codePath, { mode: "once" });
      } finally {
        this.activeProcessors.delete(codePath);
        const counts = getDaemonJobCounts(this.queueDb, { codePath });
        if (counts.queued > 0 || counts.leased > 0) {
          this.scheduleProcessing(codePath);
        }
      }
    });
  }

  private async processJobsForCodePath(
    codePath: string,
    opts: { mode: "once" | "watch"; pollMs?: number; type?: LoreJobType },
  ): Promise<LoreDaemonRunResult> {
    return this.runSerialized(codePath, async () => {
      return this.processJobLoop(codePath, opts);
    });
  }

  private async processJobLoop(
    codePath: string,
    opts: { mode: "once" | "watch"; pollMs?: number; type?: LoreJobType },
  ): Promise<LoreDaemonRunResult> {
    const ownerBase = `${process.pid}:${randomUUID()}`;
    const processedByType: Record<LoreJobType, number> = { close: 0, ingest: 0, rebuild: 0 };
    const failedByType: Record<LoreJobType, number> = { close: 0, ingest: 0, rebuild: 0 };
    let jobsProcessed = 0;
    let jobsFailed = 0;
    let idlePolls = 0;
    let lastJobId: string | null = null;
    while (true) {
      const claimed = claimDaemonJob(this.queueDb, {
        codePath,
        owner: `${ownerBase}:${jobsProcessed + jobsFailed + idlePolls}`,
        type: opts.type,
      });
      if (claimed) {
        const outcome = await this.executeJob(claimed);
        lastJobId = claimed.job.id;
        if (outcome.status === "done") {
          jobsProcessed += 1;
          processedByType[claimed.job.type] += 1;
        } else {
          jobsFailed += 1;
          failedByType[claimed.job.type] += 1;
        }
        if (opts.mode === "once") {
          const counts = getDaemonJobCounts(this.queueDb, { codePath });
          if (counts.queued === 0 && counts.leased === 0) break;
        }
        continue;
      }
      if (opts.mode === "once") break;
      idlePolls += 1;
      await sleep(Math.max(50, opts.pollMs ?? 250));
    }
    return {
      mode: opts.mode,
      jobs_processed: jobsProcessed,
      jobs_failed: jobsFailed,
      jobs_processed_by_type: processedByType,
      jobs_failed_by_type: failedByType,
      idle_polls: idlePolls,
      last_job_id: lastJobId,
    };
  }

  private async executeJob(
    detail: LoreJobDetail,
  ): Promise<{ status: "done" | "failed"; result?: unknown }> {
    const raw = getRawDaemonJob(this.queueDb, { id: detail.job.id });
    if (!raw) {
      return { status: "failed" };
    }
    try {
      const payload = JSON.parse(raw.payload_json) as CloseJobPayload | IngestJobPayload | RebuildJobPayload;
      let result: unknown;
      switch (raw.type) {
        case "close": {
          const closePayload = payload as CloseJobPayload;
          result = await this.client.close(closePayload.narrative, {
            ...(closePayload.opts ?? {}),
            codePath: raw.code_path,
            wait: true,
          });
          break;
        }
        case "ingest": {
          const ingestPayload = payload as IngestJobPayload;
          result = ingestPayload.filePath
            ? await this.client.ingestDoc(ingestPayload.filePath, { codePath: raw.code_path })
            : await this.client.ingestAll({
                codePath: raw.code_path,
                force: ingestPayload.force,
              });
          break;
        }
        case "rebuild": {
          result = await this.client.rebuild({ codePath: raw.code_path });
          break;
        }
      }
      completeDaemonJob(this.queueDb, {
        id: raw.id,
        owner: detail.job.owner ?? undefined,
        result,
      });
      return { status: "done", result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`job ${raw.id} (${raw.type}) failed: ${message}`);
      failDaemonJob(this.queueDb, {
        id: raw.id,
        owner: detail.job.owner ?? undefined,
        error: message,
        retry: false,
      });
      return { status: "failed" };
    }
  }

  private async runSerialized<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.chains.get(key) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.chains.set(
      key,
      previous
        .catch(() => {})
        .then(() => next),
    );
    await previous.catch(() => {});
    try {
      return await task();
    } finally {
      if (release) release();
      if (this.chains.get(key) === next) {
        this.chains.delete(key);
      }
    }
  }
}

export async function runLoreDaemonServer(paths: LoreDaemonPaths): Promise<void> {
  const server = new LoreDaemonServer(paths);
  await server.run();
}
