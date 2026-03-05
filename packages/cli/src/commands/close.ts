import type { WorkerClient, CloseMode, MergeStrategy } from "@lore/worker";
import { formatClose } from "@lore/worker";

export async function closeCommand(
  client: WorkerClient,
  delta: string,
  mode: CloseMode = "merge",
  mergeStrategy?: MergeStrategy,
): Promise<void> {
  const result = await client.close(delta, { mode, mergeStrategy });
  console.log(formatClose(result));
}
