import type { WorkerClient } from "@lore/worker";
import { formatJournalDesignationCli } from "../formatters.ts";

export async function narrativeDesignateCommand(
  client: WorkerClient,
  narrative: string,
  chunkId: string,
  opts: { concepts?: string[] },
): Promise<void> {
  const result = await client.designateJournalEntry(narrative, chunkId, {
    concepts: opts.concepts,
  });
  console.log(formatJournalDesignationCli(result));
}
