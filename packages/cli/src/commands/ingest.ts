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
