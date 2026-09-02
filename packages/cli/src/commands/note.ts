import type { WorkerClient, FileRef } from "@lore/worker";
import { emit } from "../output.ts";
import { formatUnattachedSymbolsCli } from "../formatters.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** Parse a --ref value into a FileRef. Formats: "path", "path:start-end" */
function parseRef(raw: string): FileRef {
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx > 0) {
    const path = raw.slice(0, colonIdx);
    const match = raw.slice(colonIdx + 1).match(/^(\d+)-(\d+)$/);
    if (match) {
      return { path, lines: [parseInt(match[1]!, 10), parseInt(match[2]!, 10)] };
    }
  }
  return { path: raw };
}

export async function noteCommand(
  client: WorkerClient,
  entry: string,
  opts: {
    concepts?: string[];
    symbols?: string[];
    refs?: string[];
    narrative?: string;
  },
): Promise<void> {
  const refs = opts.refs && opts.refs.length > 0 ? opts.refs.map(parseRef) : undefined;
  const result = await client.note(entry, {
    concepts: opts.concepts,
    symbols: opts.symbols,
    refs,
    narrative: opts.narrative,
  });

  emit(result, (value) => {
    const lines: string[] = [];
    const where = value.opened_narrative
      ? `${BOLD}${value.narrative}${RESET} ${DIM}(opened)${RESET}`
      : `${BOLD}${value.narrative}${RESET}`;
    lines.push(`Noted in ${where}`);
    // Naming the concept is what makes the routing checkable. A note filed
    // somewhere the writer cannot see is a note they cannot correct.
    if (value.routed_concept) {
      lines.push(
        `${DIM}  filed under ${value.routed_concept} — pass --concept to override${RESET}`,
      );
    }
    lines.push(...formatUnattachedSymbolsCli(value));
    return lines.join("\n");
  });
}
