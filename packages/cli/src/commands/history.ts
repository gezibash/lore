import type { WorkerClient } from "@lore/worker";
import { formatHistory } from "../formatters.ts";

export async function historyCommand(client: WorkerClient, concept: string): Promise<void> {
  const result = await client.history(concept);
  console.log(formatHistory(concept, result));
}
