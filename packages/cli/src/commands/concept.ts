import type { WorkerClient } from "@lore/worker";
import { formatLifecycleResultCli } from "../formatters.ts";
import { emit } from "../output.ts";

export async function conceptRestoreCommand(client: WorkerClient, concept: string): Promise<void> {
  const result = await client.conceptRestore(concept);
  emit(result, formatLifecycleResultCli);
}

export async function conceptRebuildCommand(client: WorkerClient, concept: string): Promise<void> {
  const result = await client.conceptRebuild(concept);
  emit(result, formatLifecycleResultCli);
}
