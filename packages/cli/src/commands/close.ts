import type { WorkerClient, CloseMode, MergeStrategy } from "@lore/worker";
import { formatClose } from "@lore/worker";
import { emit } from "../output.ts";
import { confirmOrAbort } from "../tty.ts";

export async function closeCommand(
  client: WorkerClient,
  narrative: string,
  mode: CloseMode = "merge",
  mergeStrategy?: MergeStrategy,
  fromResultId?: string,
  opts?: { wait?: boolean; pollMs?: number; force?: boolean },
) {
  if (mode === "discard") {
    const confirmed = await confirmOrAbort({
      prompt: `Discard narrative '${narrative}' without merging? [y/N] `,
      accept: (answer) => answer.toLowerCase() === "y",
      force: opts?.force,
      forceHint: "Discarding a narrative requires --force when stdin is not a TTY.",
    });
    if (!confirmed) {
      emit({ aborted: true }, () => "Aborted.");
      return undefined;
    }
  }
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
