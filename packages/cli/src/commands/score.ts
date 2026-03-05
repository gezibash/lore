import type { WorkerClient } from "@lore/worker";

export async function scoreCommand(
  client: WorkerClient,
  resultId: string,
  score: number,
): Promise<void> {
  try {
    client.scoreResult(resultId, score);
  } catch {
    throw new Error(`No cached result found for ID: ${resultId}`);
  }
  console.log(`Scored result ${resultId}: ${score}/5`);
}
