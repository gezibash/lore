import { basename } from "path";
import type { WorkerClient } from "@lore/worker";
import { createSpinner } from "boune";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function ingestFileCommand(client: WorkerClient, filePath: string): Promise<void> {
  const name = basename(filePath);
  const spinner = createSpinner(`Ingesting ${name}...`).start();
  const result = await client.ingestDoc(filePath);
  if (result.files_ingested > 0) {
    spinner.succeed(`${GREEN}✓${RESET} Ingested ${BOLD}${name}${RESET}`);
  } else {
    spinner.succeed(`${DIM}Skipped ${name} (unchanged)${RESET}`);
  }
}

export async function ingestAllCommand(client: WorkerClient): Promise<void> {
  const spinner = createSpinner("Scanning code and ingesting docs in parallel...").start();
  const { scan, ingest } = await client.ingestAll();
  const parts: string[] = [];
  parts.push(`${GREEN}✓${RESET} Complete in ${Math.max(scan.duration_ms, ingest.duration_ms)}ms`);
  parts.push(
    `  ${BOLD}Code:${RESET}  ${scan.files_scanned} files scanned, ${scan.symbols_found} symbols found`,
  );
  parts.push(
    `  ${BOLD}Docs:${RESET}  ${ingest.files_ingested} files ingested, ${ingest.files_skipped} skipped${ingest.files_removed > 0 ? `, ${ingest.files_removed} removed` : ""}`,
  );
  spinner.succeed(parts.join("\n"));
}
