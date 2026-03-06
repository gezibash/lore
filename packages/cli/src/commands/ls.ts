import type { WorkerClient } from "@lore/worker";
import { renderLs } from "@lore/rendering";
import { emit } from "../output.ts";

export async function lsCommand(
  client: WorkerClient,
  opts?: { groupBy?: "cluster" },
): Promise<void> {
  const result = await client.ls();
  emit(result, (value) => renderLs(value, { route: "cli", groupBy: opts?.groupBy }));
}
