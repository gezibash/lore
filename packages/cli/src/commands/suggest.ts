import type { WorkerClient, SuggestionKind } from "@lore/worker";
import { formatSuggest } from "@lore/worker";
import { emit } from "../output.ts";

export async function suggestCommand(
  client: WorkerClient,
  opts?: { limit?: number; kind?: string },
): Promise<void> {
  const kind = opts?.kind as SuggestionKind | undefined;
  const result = await client.suggest({ limit: opts?.limit, kind });
  emit(result, formatSuggest);
}
