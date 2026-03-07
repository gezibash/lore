import type { CloseResult, LoreJob, LoreJobDetail, WorkerClient } from "@lore/worker";
import { formatClose } from "@lore/worker";
import { emit } from "../output.ts";

function formatJob(job: LoreJob): string {
  const lines = [`${job.id}  ${job.type}  ${job.status}  ${job.subject ?? "-"}`];
  if (job.last_error) lines.push(`error: ${job.last_error}`);
  return lines.join("\n");
}

function formatJobs(jobs: LoreJob[]): string {
  if (jobs.length === 0) {
    return "No jobs.";
  }
  return jobs.map(formatJob).join("\n\n");
}

function formatJobDetail(detail: LoreJobDetail): string {
  if (detail.job.type === "close" && detail.result && typeof detail.result === "object") {
    const closeResult: CloseResult = {
      ...(detail.result as CloseResult),
      close_job: {
        id: detail.job.id,
        narrative_id: detail.job.subject ?? detail.job.id,
        narrative_name: detail.job.subject ?? "unknown",
        status: detail.job.status,
        owner: detail.job.owner,
        attempt: detail.job.attempt,
        lease_expires_at: detail.job.lease_expires_at,
        last_error: detail.job.last_error,
        created_at: detail.job.created_at,
        updated_at: detail.job.updated_at,
        completed_at: detail.job.completed_at,
      },
    };
    return `${formatJob(detail.job)}\n\n${formatClose(closeResult)}`;
  }
  if (detail.result) {
    return `${formatJob(detail.job)}\n\n${JSON.stringify(detail.result, null, 2)}`;
  }
  return formatJob(detail.job);
}

export async function closeJobsCommand(
  client: WorkerClient,
  opts?: { limit?: number; type?: "close" | "ingest" | "rebuild" },
): Promise<LoreJob[]> {
  const jobs = await client.listJobs({ limit: opts?.limit, type: opts?.type });
  emit(jobs, formatJobs);
  return jobs;
}

export async function closeJobCommand(
  client: WorkerClient,
  jobId: string,
): Promise<LoreJobDetail> {
  const detail = await client.getJobDetail(jobId);
  emit(detail, formatJobDetail);
  return detail;
}

export async function waitCommand(client: WorkerClient, jobId: string, opts?: { pollMs?: number }) {
  const detail = await client.waitForJob(jobId, { pollMs: opts?.pollMs });
  emit(detail, formatJobDetail);
  return detail;
}
