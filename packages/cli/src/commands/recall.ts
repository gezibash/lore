import { renderRecall, type RecallSection } from "@lore/rendering";
import type { WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

export async function recallCommand(
  client: WorkerClient,
  resultId: string,
  section?: RecallSection,
): Promise<void> {
  const recalled = client.recall(resultId, { section: section ?? "full" });
  if (!recalled) {
    throw new Error(`No cached result found for ID: ${resultId}`);
  }
  emit(recalled, (value) => renderRecall(value, section ?? "full"));
}
