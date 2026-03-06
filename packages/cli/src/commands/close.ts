import type { WorkerClient, CloseMode, MergeStrategy } from "@lore/worker";
import { formatClose } from "@lore/worker";

export async function closeCommand(
  client: WorkerClient,
  narrative: string,
  mode: CloseMode = "merge",
  mergeStrategy?: MergeStrategy,
  fromResultId?: string,
): Promise<void> {
  const result = await client.close(narrative, { mode, mergeStrategy, fromResultId });
  console.log(formatClose(result));
}
