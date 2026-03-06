import { renderRecall, type RecallSection } from "@lore/rendering";
import type { WorkerClient } from "@lore/worker";

export async function recallCommand(
  client: WorkerClient,
  resultId: string,
  section?: RecallSection,
): Promise<void> {
  const recalled = client.recall(resultId, { section: section ?? "full" });
  if (!recalled) {
    throw new Error(`No cached result found for ID: ${resultId}`);
  }
  console.log(renderRecall(recalled, section ?? "full"));
}
