import type { CloseWorkerRunResult, WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

function formatWorkerResult(result: CloseWorkerRunResult): string {
  return [
    `worker mode: ${result.mode}`,
    `close jobs processed: ${result.close_jobs_processed}`,
    `close jobs failed: ${result.close_jobs_failed}`,
    `maintenance jobs processed: ${result.maintenance_jobs_processed}`,
    `maintenance jobs failed: ${result.maintenance_jobs_failed}`,
    `idle polls: ${result.idle_polls}`,
    `last job: ${result.last_job_id ?? "none"}`,
  ].join("\n");
}

export async function workerCommand(
  client: WorkerClient,
  opts?: { watch?: boolean; pollMs?: number },
): Promise<CloseWorkerRunResult> {
  const result = await client.runCloseWorker(opts);
  emit(result, formatWorkerResult);
  return result;
}
