import type { WorkerClient } from "@lore/worker";
import { formatShow } from "../formatters.ts";
import { timeAgo } from "@lore/worker";

const RESET = "\x1b[0m";
const DIM = "\x1b[2m";

export async function showCommand(client: WorkerClient, target: string): Promise<void> {
  // Support ref:concept syntax (e.g., main~3:auth-model)
  const refMatch = target.match(/^(.+):(.+)$/);
  if (refMatch) {
    const [, ref, conceptName] = refMatch;
    const result = await client.show(conceptName!, { ref: ref! });
    if ("commit" in result && result.commit) {
      console.log(
        `${DIM}commit: ${result.commit.id}  (${timeAgo(result.commit.committed_at)})${RESET}\n`,
      );
    }
    console.log(formatShow(conceptName!, result.content));
    return;
  }

  const { content } = await client.show(target);
  console.log(formatShow(target, content));
}
