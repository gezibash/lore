import type { WorkerClient } from "@lore/worker";
import { formatLifecycleResultCli } from "../formatters.ts";

export async function conceptRestoreCommand(client: WorkerClient, concept: string): Promise<void> {
  const result = await client.conceptRestore(concept);
  console.log(formatLifecycleResultCli(result));
}
