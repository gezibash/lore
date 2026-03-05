import type { WorkerClient } from "@lore/worker";
import { renderStatus } from "@lore/rendering";

export async function statusCommand(client: WorkerClient): Promise<void> {
  const result = await client.status();
  console.log(renderStatus(result, { route: "cli" }));
}
