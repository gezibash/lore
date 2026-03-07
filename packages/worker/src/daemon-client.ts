import { existsSync, readFileSync } from "fs";
import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { connect } from "net";
import { LoreError } from "@lore/sdk";
import {
  ensureLoreDaemonDir,
  getLoreDaemonPaths,
  readLoreDaemonState,
  type LoreDaemonPaths,
} from "./daemon-paths.ts";
import type {
  DaemonRequest,
  DaemonResponse,
  LoreDaemonLogSnapshot,
  LoreDaemonRunResult,
  LoreDaemonStatus,
  LoreJob,
  LoreJobDetail,
  LoreJobType,
} from "./daemon-protocol.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function daemonEntryScript(): string {
  const entry = process.env.LORE_DAEMON_ENTRY ?? process.argv[1];
  if (!entry) {
    throw new Error("Unable to determine the lore CLI entrypoint for daemon startup");
  }
  return entry;
}

function daemonDisabled(): boolean {
  return process.env.LORE_DAEMON_DISABLE === "1";
}

async function sendRequest(
  socketPath: string,
  method: string,
  args: unknown[],
): Promise<unknown> {
  const request: DaemonRequest = {
    id: randomUUID(),
    method,
    args,
    cwd: process.cwd(),
  };
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
    });
    socket.on("end", () => {
      try {
        const response = JSON.parse(buffer.trim()) as DaemonResponse;
        if (!response.ok) {
          reject(new Error(response.error.message));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error);
      }
    });
    socket.on("error", (error) => {
      reject(error);
    });
  });
}

export class LoreDaemonRpcClient {
  private readonly paths: LoreDaemonPaths;

  constructor(paths = getLoreDaemonPaths()) {
    this.paths = ensureLoreDaemonDir(paths);
  }

  async ensureRunning(): Promise<LoreDaemonStatus> {
    if (daemonDisabled()) {
      throw new Error("Lore daemon usage is disabled by LORE_DAEMON_DISABLE=1");
    }
    const current = await this.status();
    if (current.running) return current;
    const entry = daemonEntryScript();
    const child = spawn(
      process.execPath,
      [
        entry,
        "daemon",
        "serve",
        "--socket",
        this.paths.socketPath,
        "--db",
        this.paths.dbPath,
        "--log",
        this.paths.logPath,
      ],
      {
        detached: true,
        stdio: "ignore",
      },
    );
    child.unref();
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      await sleep(100);
      const status = await this.status();
      if (status.running) return status;
    }
    throw new Error("Lore daemon did not start within 5 seconds");
  }

  async call(method: string, args: unknown[]): Promise<unknown> {
    await this.ensureRunning();
    return sendRequest(this.paths.socketPath, method, args);
  }

  async ping(): Promise<boolean> {
    try {
      await sendRequest(this.paths.socketPath, "ping", []);
      return true;
    } catch {
      return false;
    }
  }

  async status(): Promise<LoreDaemonStatus> {
    const state = readLoreDaemonState(this.paths);
    if (!(await this.ping())) {
      return {
        running: false,
        pid: state?.pid ?? null,
        socket_path: this.paths.socketPath,
        db_path: this.paths.dbPath,
        log_path: this.paths.logPath,
        started_at: state?.started_at ?? null,
        queued_jobs: 0,
        leased_jobs: 0,
        failed_jobs: 0,
        done_jobs: 0,
        active_lores: [],
      };
    }
    return (await sendRequest(this.paths.socketPath, "daemonStatus", [])) as LoreDaemonStatus;
  }

  async stop(): Promise<void> {
    if (!(await this.ping())) return;
    await sendRequest(this.paths.socketPath, "stopDaemon", []);
  }

  async listJobs(opts?: {
    codePath?: string;
    limit?: number;
    type?: LoreJobType;
  }): Promise<LoreJob[]> {
    return (await this.call("listJobs", [opts ?? {}])) as LoreJob[];
  }

  async getJobDetail(jobId: string, opts?: { codePath?: string }): Promise<LoreJobDetail> {
    return (await this.call("getJobDetail", [jobId, opts ?? {}])) as LoreJobDetail;
  }

  async waitForJob(
    jobId: string,
    opts?: { codePath?: string; pollMs?: number },
  ): Promise<LoreJobDetail> {
    return (await this.call("waitForJob", [jobId, opts ?? {}])) as LoreJobDetail;
  }

  async runCloseWorker(opts?: {
    codePath?: string;
    watch?: boolean;
    pollMs?: number;
  }): Promise<LoreDaemonRunResult> {
    return (await this.call("runCloseWorker", [opts ?? {}])) as LoreDaemonRunResult;
  }
}

export async function startLoreDaemon(): Promise<LoreDaemonStatus> {
  const client = new LoreDaemonRpcClient();
  return client.ensureRunning();
}

export async function getLoreDaemonStatus(): Promise<LoreDaemonStatus> {
  const client = new LoreDaemonRpcClient();
  return client.status();
}

export async function stopLoreDaemon(): Promise<void> {
  const client = new LoreDaemonRpcClient();
  await client.stop();
}

export function readLoreDaemonLog(limit = 200): LoreDaemonLogSnapshot {
  const paths = getLoreDaemonPaths();
  if (!existsSync(paths.logPath)) {
    return { path: paths.logPath, lines: [] };
  }
  const lines = readFileSync(paths.logPath, "utf-8")
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    path: paths.logPath,
    lines: lines.slice(Math.max(0, lines.length - Math.max(1, limit))),
  };
}
