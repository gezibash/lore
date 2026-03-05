import type { WorkerClient } from "@lore/worker";
import { createSpinner } from "boune";
import { formatRebuildCli } from "../formatters.ts";

export async function rebuildCommand(client: WorkerClient): Promise<void> {
  const spinner = createSpinner("Rebuilding from disk...").start();
  const result = await client.rebuild();
  spinner.succeed(formatRebuildCli(result));
}
