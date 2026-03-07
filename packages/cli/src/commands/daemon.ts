import {
  getLoreDaemonStatus,
  readLoreDaemonLog,
  startLoreDaemon,
  stopLoreDaemon,
  type LoreDaemonLogSnapshot,
  type LoreDaemonStatus,
} from "@lore/worker";
import { emit } from "../output.ts";

function formatStatus(status: LoreDaemonStatus): string {
  if (!status.running) {
    return `Daemon not running.\nSocket: ${status.socket_path}`;
  }
  return [
    `Daemon running (pid ${status.pid})`,
    `Socket: ${status.socket_path}`,
    `DB: ${status.db_path}`,
    `Log: ${status.log_path}`,
    `Started: ${status.started_at ?? "unknown"}`,
    `Jobs: queued=${status.queued_jobs} leased=${status.leased_jobs} failed=${status.failed_jobs} done=${status.done_jobs}`,
    `Active lores: ${status.active_lores.length > 0 ? status.active_lores.join(", ") : "none"}`,
  ].join("\n");
}

function formatLog(snapshot: LoreDaemonLogSnapshot): string {
  if (snapshot.lines.length === 0) {
    return `No daemon log lines at ${snapshot.path}`;
  }
  return snapshot.lines.join("\n");
}

export async function daemonStartCommand(): Promise<LoreDaemonStatus> {
  const status = await startLoreDaemon();
  emit(status, formatStatus);
  return status;
}

export async function daemonStatusCommand(): Promise<LoreDaemonStatus> {
  const status = await getLoreDaemonStatus();
  emit(status, formatStatus);
  return status;
}

export async function daemonStopCommand(): Promise<{ stopped: boolean }> {
  await stopLoreDaemon();
  const result = { stopped: true };
  emit(result, () => "Daemon stopped.");
  return result;
}

export async function daemonLogsCommand(lines = 100): Promise<LoreDaemonLogSnapshot> {
  const snapshot = readLoreDaemonLog(lines);
  emit(snapshot, formatLog);
  return snapshot;
}
