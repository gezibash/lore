import type { CloseJob, CloseJobDetail, WorkerClient } from "@lore/worker";
import { formatClose } from "@lore/worker";
import { emit } from "../output.ts";

function formatJob(job: CloseJob): string {
  const lines = [`${job.id}  ${job.status}  ${job.narrative_name}`];
  if (job.last_error) lines.push(`error: ${job.last_error}`);
  return lines.join("\n");
}

function formatJobs(jobs: CloseJob[]): string {
  if (jobs.length === 0) {
    return "No close jobs.";
  }
  return jobs.map(formatJob).join("\n\n");
}

function formatJobDetail(detail: CloseJobDetail): string {
  if (detail.result) {
    return `${formatJob(detail.job)}\n\n${formatClose({ ...detail.result, close_job: detail.job })}`;
  }
  return formatJob(detail.job);
}

export async function closeJobsCommand(
  client: WorkerClient,
  opts?: { limit?: number },
): Promise<CloseJob[]> {
  const jobs = await client.listCloseJobs({ limit: opts?.limit });
  emit(jobs, formatJobs);
  return jobs;
}

export async function closeJobCommand(
  client: WorkerClient,
  jobId: string,
): Promise<CloseJobDetail> {
  const detail = await client.getCloseJobDetail(jobId);
  emit(detail, formatJobDetail);
  return detail;
}

export async function waitCommand(client: WorkerClient, jobId: string, opts?: { pollMs?: number }) {
  const result = await client.waitForCloseJob(jobId, { pollMs: opts?.pollMs });
  emit(result, formatClose);
  return result;
}
