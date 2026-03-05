import { formatNarrativeTrail, type WorkerClient } from "@lore/worker";

export async function trailCommand(client: WorkerClient, narrative: string): Promise<void> {
  const result = await client.showNarrativeTrail(narrative);
  console.log(formatNarrativeTrail(result));
}
