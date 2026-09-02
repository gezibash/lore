import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  type Dirent,
} from "fs";
import { dirname, join, resolve } from "path";

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { connect } from "net";
import {
  acquireLoreLock,
  ensureLoreDaemonDir,
  getLoreDaemonPaths,
  loreSpawnLockPath,
  readLoreDaemonState,
  releaseLoreLock,
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
  SerializedDaemonError,
} from "./daemon-protocol.ts";
import { LoreError, type LoreErrorCode } from "@lore/sdk";

/** The error the daemon raised, with the code and details it carried.
 *
 *  A plain `new Error(message)` dropped both. `handleCliError` reads `code`
 *  off a `LoreError`, so every daemon-routed failure reported `CLI_ERROR` and
 *  no candidate list — and the daemon is the default path, so that was every
 *  failure a user saw. */
function reviveDaemonError(error: SerializedDaemonError): Error {
  if (error.code) {
    return new LoreError(
      error.code as LoreErrorCode,
      error.message,
      (error.details ?? undefined) as Record<string, unknown> | undefined,
    );
  }
  const revived = new Error(error.message);
  if (error.name) revived.name = error.name;
  return revived;
}

const SPAWN_TIMEOUT_MS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The CLI entry script the daemon child must run, or null when this program
 * has none on disk.
 *
 * A compiled binary reports the embedded path `/$bunfs/root/lore` in
 * `process.argv[1]`. That path is not a file. Passed back as the child's first
 * argument, it becomes the command the child runs, and the child exits with
 * `unknown command '/$bunfs/root/lore'` before it binds the socket. A compiled
 * binary is its own entry and takes the subcommand directly.
 */
export function daemonEntryScript(): string | null {
  const entry = process.env.LORE_DAEMON_ENTRY ?? process.argv[1];
  if (!entry) return null;
  try {
    // Not existsSync: Bun's embedded filesystem answers true for the virtual
    // path, and so does statSync. realpathSync is the one call that reaches
    // the real disk, and it fails with ENOENT on `/$bunfs/root/lore`.
    realpathSync(entry);
  } catch {
    return null;
  }
  return entry;
}

/** Child argv for `daemon serve`, appended to `process.execPath`. A null entry
 *  means a compiled binary, which runs the subcommand itself. */
export function daemonSpawnArgs(entry: string | null, paths: LoreDaemonPaths): string[] {
  const serve = [
    "daemon",
    "serve",
    "--socket",
    paths.socketPath,
    "--db",
    paths.dbPath,
    "--log",
    paths.logPath,
  ];
  return entry === null ? serve : [entry, ...serve];
}

function daemonDisabled(): boolean {
  return process.env.LORE_DAEMON_DISABLE === "1";
}

/** Directory whose TypeScript sources decide whether the daemon is current:
 *  the workspace root when running from a checkout, else the installed
 *  package root. Returns null when neither can be located. */
export function sourceRootForEntry(entry: string): string | null {
  let dir = dirname(resolve(entry));
  for (let depth = 0; depth < 8; depth++) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf-8")) as { workspaces?: unknown };
        if (parsed.workspaces) return dir;
      } catch {
        // Unreadable manifest: keep walking rather than guessing a root.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/** Newest mtime across the installation's own .ts sources, or null when the
 *  root cannot be resolved. A long-lived daemon keeps serving the code it was
 *  spawned with, so an edit made after `started_at` is invisible until it is
 *  restarted — the failure mode is silent, and looks like the edit did
 *  nothing. */
export function newestSourceMtimeMs(root: string): number | null {
  let newest: number | null = null;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const name = entry.name;
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(dir, name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!name.endsWith(".ts")) continue;
      try {
        const mtime = statSync(full).mtimeMs;
        if (newest === null || mtime > newest) newest = mtime;
      } catch {
        // Raced with a delete; the remaining files still bound the answer.
      }
    }
  };
  walk(root, 0);
  return newest;
}

/** True when the running daemon was spawned before the newest source edit. */
export function daemonIsStale(status: Pick<LoreDaemonStatus, "started_at">): boolean {
  if (process.env.LORE_DAEMON_STALE_CHECK === "0") return false;
  if (!status.started_at) return false;
  const startedAt = Date.parse(status.started_at);
  if (Number.isNaN(startedAt)) return false;
  // A compiled binary carries its code inside itself, so source mtimes say
  // nothing about what the daemon runs. Restarting it also cannot make it
  // newer: the check would stop the daemon before every call and start the
  // same code again.
  const entry = daemonEntryScript();
  if (entry === null) return false;
  const root = sourceRootForEntry(entry);
  if (!root) return false;
  const newest = newestSourceMtimeMs(root);
  return newest !== null && newest > startedAt;
}

async function sendRequest(socketPath: string, method: string, args: unknown[]): Promise<unknown> {
  const request: DaemonRequest = {
    id: randomUUID(),
    method,
    args,
    cwd: process.cwd(),
  };
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath);
    let buffer = "";
    let settled = false;
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(error);
    };
    socket.setEncoding("utf-8");
    socket.on("connect", () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      // The daemon keeps the connection open after answering, so resolve on
      // the first complete newline-framed response instead of waiting for
      // end-of-stream.
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex === -1) return;
      settled = true;
      socket.destroy();
      try {
        const response = JSON.parse(buffer.slice(0, newlineIndex)) as DaemonResponse;
        if (!response.ok) {
          reject(reviveDaemonError(response.error));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("end", () => fail(new Error("Lore daemon closed the connection without a response")));
    socket.on("error", fail);
  });
}

export class LoreDaemonRpcClient {
  private readonly paths: LoreDaemonPaths;

  constructor(paths = getLoreDaemonPaths()) {
    this.paths = ensureLoreDaemonDir(paths);
  }

  private startTimeoutMessage(): string {
    return `Lore daemon did not start within 5 seconds. The daemon log records why: ${this.paths.logPath}`;
  }

  async ensureRunning(): Promise<LoreDaemonStatus> {
    if (daemonDisabled()) {
      throw new Error("Lore daemon usage is disabled by LORE_DAEMON_DISABLE=1");
    }
    const current = await this.status();
    if (current.running) {
      if (!daemonIsStale(current)) return current;
      // Never cut a job off mid-flight: a leased job holds state the restart
      // would strand. Serving stale code for the rest of this run beats it.
      if (current.leased_jobs > 0) return current;
      await this.stop();
    }

    // Concurrent CLI invocations all see "not running" at once and each spawn a
    // daemon — a benchmark at 10-way parallelism left seven of them competing
    // for one socket, degrading every request. The lock winner spawns; the
    // losers wait for the socket it opens rather than starting children the
    // daemon-side lock would only make exit again.
    const lockPath = loreSpawnLockPath(this.paths);
    if (!acquireLoreLock(lockPath)) {
      const waitUntil = Date.now() + SPAWN_TIMEOUT_MS;
      while (Date.now() < waitUntil) {
        await sleep(100);
        const status = await this.status();
        if (status.running) return status;
      }
      throw new Error(this.startTimeoutMessage());
    }

    try {
      // A discarded stdio hides every child startup failure behind the
      // timeout below. The daemon writes to this log anyway, so a child that
      // dies early lands its error directly above the lines it never wrote.
      const logFd = openSync(this.paths.logPath, "a");
      try {
        const child = spawn(process.execPath, daemonSpawnArgs(daemonEntryScript(), this.paths), {
          detached: true,
          stdio: ["ignore", logFd, logFd],
        });
        child.unref();
      } finally {
        closeSync(logFd);
      }
      const deadline = Date.now() + SPAWN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(100);
        const status = await this.status();
        if (status.running) return status;
      }
      throw new Error(this.startTimeoutMessage());
    } finally {
      releaseLoreLock(lockPath);
    }
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
    opts?: { codePath?: string; pollMs?: number; timeoutMs?: number },
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
  const lines = readFileSync(paths.logPath, "utf-8").split(/\r?\n/).filter(Boolean);
  return {
    path: paths.logPath,
    lines: lines.slice(Math.max(0, lines.length - Math.max(1, limit))),
  };
}
