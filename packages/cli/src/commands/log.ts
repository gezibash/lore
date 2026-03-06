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
  topics: string[],
  refStrs?: string[],
): Promise<void> {
  const refs = refStrs && refStrs.length > 0 ? refStrs.map(parseRef) : undefined;
  const result = await client.log(narrative, entry, { topics, refs });
  console.log(formatLogCli(result.note));
}
