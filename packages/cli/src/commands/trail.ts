import { formatNarrativeTrail, type WorkerClient } from "@lore/worker";

export async function trailCommand(
  client: WorkerClient,
  narrative: string,
  fromResultId?: string,
): Promise<void> {
  const result = await client.showNarrativeTrail(narrative, fromResultId ? { fromResultId } : undefined);
  console.log(formatNarrativeTrail(result));
}
