import type { WorkerClient } from "@lore/worker";
import { formatHistory } from "../formatters.ts";
import { emit } from "../output.ts";

export async function historyCommand(client: WorkerClient, concept: string): Promise<void> {
  const result = await client.history(concept);
  emit(result, (value) => formatHistory(concept, value));
}
