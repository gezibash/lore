import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export interface LoreDaemonPaths {
  baseDir: string;
  socketPath: string;
  statePath: string;
  logPath: string;
  dbPath: string;
}

export interface LoreDaemonStateFile {
  pid: number;
  socket_path: string;
  db_path: string;
  log_path: string;
  started_at: string;
}

export function getLoreDaemonPaths(): LoreDaemonPaths {
  const baseDir = join(homedir(), ".lore", "daemon");
  return {
    baseDir,
    socketPath: join(baseDir, "lored.sock"),
    statePath: join(baseDir, "state.json"),
    logPath: join(baseDir, "daemon.log"),
    dbPath: join(baseDir, "queue.sqlite"),
  };
}

export function ensureLoreDaemonDir(paths = getLoreDaemonPaths()): LoreDaemonPaths {
  mkdirSync(paths.baseDir, { recursive: true });
  return paths;
}

export function writeLoreDaemonState(
  state: LoreDaemonStateFile,
  paths = getLoreDaemonPaths(),
): void {
  ensureLoreDaemonDir(paths);
  writeFileSync(paths.statePath, JSON.stringify(state, null, 2));
}

export function readLoreDaemonState(
  paths = getLoreDaemonPaths(),
): LoreDaemonStateFile | null {
  try {
    return JSON.parse(readFileSync(paths.statePath, "utf-8")) as LoreDaemonStateFile;
  } catch {
    return null;
  }
}

export function removeLoreDaemonState(paths = getLoreDaemonPaths()): void {
  try {
    rmSync(paths.statePath, { force: true });
  } catch {}
}

/** Held for the daemon's lifetime: exactly one process binds the socket. */
export function loreDaemonLockPath(paths = getLoreDaemonPaths()): string {
  return `${paths.socketPath}.lock`;
}

/** Held by a CLI only while it starts a daemon, so a stampede spawns one child. */
export function loreSpawnLockPath(paths = getLoreDaemonPaths()): string {
  return `${paths.socketPath}.spawn.lock`;
}

function readLockPid(lockPath: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(lockPath, "utf-8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Take `lockPath` for this process, or report that a live holder has it.
 *
 * Staleness is decided by asking the OS whether the recorded pid still exists,
 * not by the lock file's age: a slow-but-healthy holder would outlive any
 * timeout we picked, and stealing its lock is exactly the double-start this
 * guards against.
 */
export function acquireLoreLock(lockPath: string): boolean {
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      return true;
    } catch {
      const pid = readLockPid(lockPath);
      if (pid !== null && isProcessAlive(pid)) return false;
      // Stale lock left by a dead holder. rename() is atomic, so only one
      // contender reclaims it; the losers loop and see the winner's live pid.
      try {
        const claimPath = `${lockPath}.${process.pid}`;
        renameSync(lockPath, claimPath);
        rmSync(claimPath, { force: true });
      } catch {}
    }
  }
  return false;
}

/** Release only our own lock — never one a reclaimer has since taken. */
export function releaseLoreLock(lockPath: string): void {
  if (readLockPid(lockPath) !== process.pid) return;
  try {
    rmSync(lockPath, { force: true });
  } catch {}
}
