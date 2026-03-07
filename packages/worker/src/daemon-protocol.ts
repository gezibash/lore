import type { CloseResult } from "@lore/sdk";

export type LoreJobType = "close" | "ingest" | "rebuild";
export type LoreJobStatus = "queued" | "leased" | "done" | "failed";

export interface LoreJob {
  id: string;
  code_path: string;
  type: LoreJobType;
  subject: string | null;
  status: LoreJobStatus;
  owner: string | null;
  attempt: number;
  lease_expires_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface LoreJobDetail {
  job: LoreJob;
  result?: unknown | null;
}

export interface LoreJobWaitOptions {
  codePath?: string;
  pollMs?: number;
}

export interface LoreDaemonStatus {
  running: boolean;
  pid: number | null;
  socket_path: string;
  db_path: string;
  log_path: string;
  started_at: string | null;
  queued_jobs: number;
  leased_jobs: number;
  failed_jobs: number;
  done_jobs: number;
  active_lores: string[];
}

export interface LoreDaemonRunResult {
  mode: "once" | "watch";
  jobs_processed: number;
  jobs_failed: number;
  jobs_processed_by_type: Record<LoreJobType, number>;
  jobs_failed_by_type: Record<LoreJobType, number>;
  idle_polls: number;
  last_job_id: string | null;
}

export interface LoreDaemonLogSnapshot {
  path: string;
  lines: string[];
}

export interface SerializedDaemonError {
  code?: string;
  message: string;
  details?: unknown;
  name?: string;
}

export interface DaemonRequest {
  id: string;
  method: string;
  args: unknown[];
  cwd?: string;
}

export interface DaemonSuccessResponse {
  id: string;
  ok: true;
  result: unknown;
}

export interface DaemonErrorResponse {
  id: string;
  ok: false;
  error: SerializedDaemonError;
}

export type DaemonResponse = DaemonSuccessResponse | DaemonErrorResponse;

export type QueuedCloseResult = CloseResult & {
  close_job: {
    id: string;
    narrative_id: string;
    narrative_name: string;
    status: LoreJobStatus;
    owner: string | null;
    attempt: number;
    lease_expires_at: string | null;
    last_error: string | null;
    created_at: string;
    updated_at: string;
    completed_at: string | null;
  };
};
