import type { WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

export async function scoreCommand(
  client: WorkerClient,
  resultId: string,
  score: number,
): Promise<void> {
  try {
    await client.scoreResult(resultId, score);
  } catch {
    throw new Error(`No cached result found for ID: ${resultId}`);
  }
  emit({ ok: true, result_id: resultId, score }, () => `Scored result ${resultId}: ${score}/5`);
}
