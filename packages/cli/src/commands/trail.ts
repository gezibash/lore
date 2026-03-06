import { formatNarrativeTrail, type WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

export async function trailCommand(
  client: WorkerClient,
  narrative: string,
  fromResultId?: string,
): Promise<void> {
  const result = await client.showNarrativeTrail(
    narrative,
    fromResultId ? { fromResultId } : undefined,
  );
  emit(result, formatNarrativeTrail);
}
