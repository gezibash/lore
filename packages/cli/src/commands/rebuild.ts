import type { WorkerClient } from "@lore/worker";
import { formatRebuildCli } from "../formatters.ts";
import { emit, isJsonOutput } from "../output.ts";
import { createSpinner } from "../tty.ts";

export async function rebuildCommand(client: WorkerClient): Promise<void> {
  if (isJsonOutput()) {
    emit(await client.rebuild());
    return;
  }
  const spinner = createSpinner("Rebuilding from disk...").start();
  try {
    const result = await client.rebuild();
    spinner.succeed(formatRebuildCli(result));
  } catch (error) {
    spinner.clear();
    throw error;
  }
}
