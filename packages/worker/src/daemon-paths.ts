import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

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
