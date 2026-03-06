import type { WorkerClient } from "@lore/worker";
import { renderStatus } from "@lore/rendering";
import { emit } from "../output.ts";

export async function statusCommand(
  client: WorkerClient,
  opts?: { details?: boolean },
): Promise<void> {
  const result = await client.status();
  emit(result, (value) => renderStatus(value, { route: "cli", details: opts?.details }));
}
