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
  ensureLoreDaemonDir,
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

type DirectClient = ReturnType<typeof createLoreClient>;

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

function getRequestCodePath(method: string, args: unknown[], fallbackCwd?: string): string | undefined {
  switch (method) {
    case "register":
      return typeof args[0] === "string" ? (args[0] as string) : fallbackCwd;
    case "close":
    case "status":
    case "ask":
    case "query":
    case "recall":
    case "show":
    case "showNarrativeTrail":
    case "scoreResult":
    case "open":
    case "write":
    case "log":
    case "designateJournalEntry":
    case "setLoreMindConfig":
    case "unsetLoreMindConfig":
    case "cloneLoreMindConfig":
    case "conceptRename":
    case "conceptArchive":
    case "conceptRestore":
    case "conceptMerge":
    case "conceptSplit":
    case "conceptPatch":
    case "setConceptRelation":
    case "unsetConceptRelation":
    case "tagConcept":
    case "untagConcept":
    case "bindSymbol":
    case "unbindSymbol":
    case "migrate":
    case "migrateStatus":
    case "repair":
    case "resetLoreMind":
    case "removeLoreMind":
    case "getJobDetail":
    case "waitForJob":
    case "listJobs":
    case "runCloseWorker":
      return getCodePathFromOptions(args.at(-1)) ?? fallbackCwd;
    case "ingestDoc":
    case "ingestAll":
    case "rebuild":
      return getCodePathFromOptions(args[0]) ?? fallbackCwd;
    default:
      return getCodePathFromOptions(args.at(-1)) ?? fallbackCwd;
  }
}

export class LoreDaemonServer {
  private readonly client: DirectClient;
  private readonly paths: LoreDaemonPaths;
  private readonly queueDb;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly activeProcessors = new Set<string>();
  private readonly startedAt = new Date().toISOString();
  private server = createServer((socket) => {
    void this.handleSocket(socket);
  });
  private shuttingDown = false;

  constructor(paths: LoreDaemonPaths) {
    this.paths = ensureLoreDaemonDir(paths);
    this.queueDb = openDaemonQueueDb(this.paths.dbPath);
    this.client = createLoreClient();
  }

  async run(): Promise<void> {
    ensureLoreDaemonDir(this.paths);
    try {
      rmSync(this.paths.socketPath, { force: true });
    } catch {}
    await new Promise<void>((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.paths.socketPath, () => {
        this.server.off("error", reject);
        resolve();
      });
    });
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
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      const raw = buffer.slice(0, newlineIndex);
      buffer = "";
      void this.respond(socket, raw);
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
      socket.end(`${JSON.stringify(response)}\n`);
    } catch (error) {
      const response: DaemonResponse = {
        id: request?.id ?? randomUUID(),
        ok: false,
        error: serializeError(error),
      };
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
          args[1] as { codePath?: string; pollMs?: number } | undefined,
        );
      case "runCloseWorker":
        return this.processJobsForCodePath(
          routeKeyForCodePath(getRequestCodePath("runCloseWorker", args, request.cwd)),
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
          args[0] as { codePath?: string; wait?: boolean } | undefined,
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
        const codePath = getRequestCodePath(request.method, args, request.cwd);
        return this.runSerialized(routeKeyForCodePath(codePath), async () => {
          const fn = (this.client as unknown as Record<string, (...args: unknown[]) => unknown>)[
            request.method
          ];
          if (typeof fn !== "function") {
            throw new Error(`Unknown daemon method '${request.method}'`);
          }
          return await fn.apply(this.client, args);
        });
      }
    }
  }

  private withCallerCodePath(method: string, args: unknown[], cwd?: string): unknown[] {
    const codePath = cwd ? resolve(cwd) : undefined;
    const withCodePath = <T extends Record<string, unknown> | undefined>(
      value: T,
    ): T | { codePath: string } => {
      if (!codePath) return (value ?? {}) as T;
      if (!value) return { codePath };
      if ("codePath" in value && typeof value.codePath === "string") return value;
      return { ...value, codePath };
    };
    switch (method) {
      case "open":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "write":
      case "log":
      case "designateJournalEntry":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "status":
        return [withCodePath(args[0] as Record<string, unknown> | undefined)];
      case "close":
      case "ask":
      case "query":
      case "recall":
      case "show":
      case "showNarrativeTrail":
        return [args[0], withCodePath(args[1] as Record<string, unknown> | undefined)];
      case "scoreResult":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "setLoreMindConfig":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "unsetLoreMindConfig":
      case "cloneLoreMindConfig":
      case "conceptArchive":
      case "conceptRestore":
      case "conceptSplit":
        return [args[0], withCodePath(args[1] as Record<string, unknown> | undefined)];
      case "conceptRename":
      case "conceptMerge":
      case "conceptPatch":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "setConceptRelation":
        return [
          args[0],
          args[1],
          args[2],
          withCodePath(args[3] as Record<string, unknown> | undefined),
        ];
      case "unsetConceptRelation":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "tagConcept":
      case "untagConcept":
      case "bindSymbol":
      case "unbindSymbol":
        return [args[0], args[1], withCodePath(args[2] as Record<string, unknown> | undefined)];
      case "migrate":
      case "migrateStatus":
      case "repair":
      case "resetLoreMind":
        return args.length === 0
          ? [withCodePath(undefined)]
          : [...args.slice(0, -1), withCodePath(args.at(-1) as Record<string, unknown> | undefined)];
      case "ingestDoc":
        return [args[0], withCodePath(args[1] as Record<string, unknown> | undefined)];
      case "ingestAll":
      case "rebuild":
      case "computeConceptHealth":
      case "healConcepts":
      case "refreshEmbeddings":
      case "reEmbed":
      case "rebindAll":
      case "rescan":
      case "autoBind":
        return [withCodePath(args[0] as Record<string, unknown> | undefined)];
      case "explainConceptHealth":
        return [args[0], withCodePath(args[1] as Record<string, unknown> | undefined)];
      case "listJobs":
        return [withCodePath(args[0] as Record<string, unknown> | undefined)];
      case "getJobDetail":
      case "waitForJob":
        return [args[0], withCodePath(args[1] as Record<string, unknown> | undefined)];
      case "runCloseWorker":
        return [withCodePath(args[0] as Record<string, unknown> | undefined)];
      default:
        return args;
    }
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
    opts?: { codePath?: string; wait?: boolean },
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
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<LoreJobDetail> {
    const codePath = routeKeyForCodePath(opts?.codePath);
    while (true) {
      const detail = await this.getJobDetail(jobId, { codePath });
      if (detail.job.status === "done") return detail;
      if (detail.job.status === "failed") {
        throw new Error(detail.job.last_error ?? `Daemon job '${jobId}' failed`);
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
            : await this.client.ingestAll({ codePath: raw.code_path });
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
