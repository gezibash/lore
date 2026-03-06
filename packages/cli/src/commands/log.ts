import type { WorkerClient, FileRef } from "@lore/worker";
import { formatLogCli } from "../formatters.ts";

/**
 * Parse a --ref value into a FileRef.
 * Formats: "path", "path:start-end"
 */
function parseRef(raw: string): FileRef {
  const colonIdx = raw.lastIndexOf(":");
  if (colonIdx > 0) {
    const path = raw.slice(0, colonIdx);
    const range = raw.slice(colonIdx + 1);
    const match = range.match(/^(\d+)-(\d+)$/);
    if (match) {
      return { path, lines: [parseInt(match[1]!, 10), parseInt(match[2]!, 10)] };
    }
  }
  return { path: raw };
}

export async function logCommand(
  client: WorkerClient,
  narrative: string,
  entry: string,
  opts: {
    concepts: string[];
    topics?: string[];
    symbols?: string[];
    refs?: string[];
  },
): Promise<void> {
  const refs = opts.refs && opts.refs.length > 0 ? opts.refs.map(parseRef) : undefined;
  const result = await client.log(narrative, entry, {
    concepts: opts.concepts,
    topics: opts.topics,
    symbols: opts.symbols,
    refs,
  });
  console.log(formatLogCli(result.note));
}
