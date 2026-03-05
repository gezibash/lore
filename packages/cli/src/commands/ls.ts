import type { WorkerClient } from "@lore/worker";
import { renderLs } from "@lore/rendering";

export async function lsCommand(
  client: WorkerClient,
  opts?: { groupBy?: "cluster" },
): Promise<void> {
  const result = await client.ls();
  console.log(renderLs(result, { route: "cli", groupBy: opts?.groupBy }));
}
