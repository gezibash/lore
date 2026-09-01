import { basename } from "path";
import type { WorkerClient } from "@lore/worker";
import { emit, isJsonOutput } from "../output.ts";
import { createSpinner } from "../tty.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function ingestFileCommand(client: WorkerClient, filePath: string): Promise<void> {
  if (isJsonOutput()) {
    const result = await client.ingestDoc(filePath);
    emit({ kind: "file", file: filePath, result });
    return;
  }
  const name = basename(filePath);
  const spinner = createSpinner(`Ingesting ${name}...`).start();
  try {
    const result = await client.ingestDoc(filePath);
    if (result.files_ingested > 0) {
      spinner.succeed(`Ingested ${BOLD}${name}${RESET}`);
    } else {
      spinner.succeed(`${DIM}Skipped ${name} (unchanged)${RESET}`);
    }
  } catch (error) {
    spinner.clear();
    throw error;
  }
}

/** Queue a full ingest and return. The git hook uses this: a commit must not
 *  wait for a scan. */
export async function queueIngestAllCommand(
  client: WorkerClient,
  opts?: { force?: boolean },
): Promise<void> {
  const job = await client.queueIngestAll({ force: opts?.force });
  if (isJsonOutput()) {
    emit({ kind: "queued", job });
    return;
  }
  if (!job) {
    // No daemon means no queue. Say so rather than running the scan here: the
    // caller asked not to wait, and a hook that scans blocks the commit.
    console.log(`${DIM}No daemon is running, so nothing was queued.${RESET}`);
    return;
  }
  console.log(`Queued ingest ${BOLD}${job.id}${RESET}`);
}

export async function ingestAllCommand(
  client: WorkerClient,
  opts?: { force?: boolean },
): Promise<void> {
  if (isJsonOutput()) {
    const { scan, ingest } = await client.ingestAll({ force: opts?.force });
    emit({ kind: "all", scan, ingest });
    return;
  }
  const spinner = createSpinner("Refreshing code and docs...").start();
  try {
    const { scan, ingest } = await client.ingestAll({ force: opts?.force });
    const parts: string[] = [];
    parts.push(`Complete in ${Math.max(scan.duration_ms, ingest.duration_ms)}ms`);
    parts.push(
      `  ${BOLD}Code:${RESET}  ${scan.files_scanned} files scanned, ${scan.symbols_found} symbols found${scan.files_failed ? `, ${scan.files_failed} failed` : ""}`,
    );
    parts.push(
      `  ${BOLD}Docs:${RESET}  ${ingest.files_ingested} files ingested, ${ingest.files_skipped} skipped${ingest.files_failed ? `, ${ingest.files_failed} failed` : ""}${ingest.files_removed > 0 ? `, ${ingest.files_removed} removed` : ""}`,
    );
    if (ingest.failed_paths?.length) {
      // The count alone hides which document never reached the lake.
      parts.push(`  ${BOLD}Failed:${RESET} ${ingest.failed_paths.join(", ")}`);
    }
    spinner.succeed(parts.join("\n"));
  } catch (error) {
    spinner.clear();
    throw error;
  }
}
