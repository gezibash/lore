import type { WorkerClient } from "@lore/worker";
import { timeAgo } from "@lore/worker";
import { emit } from "../output.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

export async function commitlogCommand(client: WorkerClient, limit: number = 20, since?: string): Promise<void> {
  const entries = client.commitLog({ limit, since });

  if (entries.length === 0) {
    emit(entries, () => `${DIM}No commits yet${RESET}`);
    return;
  }

  const lines: string[] = [];
  for (const entry of entries) {
    lines.push(`${YELLOW}${entry.id}${RESET}  ${DIM}${timeAgo(entry.committedAt)}${RESET}`);

    if (entry.narrative) {
      lines.push(
        `  ${BOLD}Narrative:${RESET} ${CYAN}${entry.narrative.name}${RESET} — ${entry.narrative.intent}`,
      );
      lines.push(`  ${DIM}${entry.narrative.entryCount} entries${RESET}`);
    } else if (entry.lifecycleType) {
      lines.push(
        `  ${BOLD}${entry.lifecycleType}:${RESET} ${entry.message.replace(/^lifecycle:\s+\S+\s+/, "")}`,
      );
    } else {
      lines.push(`  ${BOLD}${entry.message}${RESET}`);
    }

    if (entry.diff) {
      const parts: string[] = [];
      if (entry.diff.added.length > 0) {
        parts.push(`${GREEN}+${entry.diff.added.join(", +")}${RESET}`);
      }
      if (entry.diff.modified.length > 0) {
        parts.push(`${CYAN}~${entry.diff.modified.join(", ~")}${RESET}`);
      }
      if (entry.diff.removed.length > 0) {
        parts.push(`${RED}-${entry.diff.removed.join(", -")}${RESET}`);
      }
      if (parts.length > 0) {
        lines.push(`  ${parts.join("  ")}`);
      }
    }

    lines.push("");
  }

  emit(entries, () => lines.join("\n"));
}
