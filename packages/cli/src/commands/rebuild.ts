import type { WorkerClient } from "@lore/worker";
import { formatRebuildCli } from "../formatters.ts";
import { createSpinner } from "../tty.ts";

export async function rebuildCommand(client: WorkerClient): Promise<void> {
  const spinner = createSpinner("Rebuilding from disk...").start();
  try {
    const result = await client.rebuild();
    spinner.succeed(formatRebuildCli(result));
  } catch (error) {
    spinner.clear();
    throw error;
  }
}
