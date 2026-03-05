import type { WorkerClient, SuggestionKind } from "@lore/worker";
import { formatSuggest } from "@lore/worker";

export async function suggestCommand(
  client: WorkerClient,
  opts?: { limit?: number; kind?: string },
): Promise<void> {
  const kind = opts?.kind as SuggestionKind | undefined;
  const result = await client.suggest({ limit: opts?.limit, kind });
  process.stdout.write(formatSuggest(result) + "\n");
}
