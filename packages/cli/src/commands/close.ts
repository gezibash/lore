import type { WorkerClient, CloseMode, MergeStrategy } from "@lore/worker";
import { formatClose } from "@lore/worker";
import { emit } from "../output.ts";

export async function closeCommand(
  client: WorkerClient,
  narrative: string,
  mode: CloseMode = "merge",
  mergeStrategy?: MergeStrategy,
  fromResultId?: string,
  opts?: { wait?: boolean; pollMs?: number },
){
  const result = await client.close(narrative, {
    mode,
    mergeStrategy,
    fromResultId,
    wait: opts?.wait,
    pollMs: opts?.pollMs,
  });
  emit(result, formatClose);
  return result;
}
