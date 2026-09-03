import { formatCoverage, type WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";
import { createSpinner } from "../tty.ts";

const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export async function scanCommand(client: WorkerClient): Promise<void> {
  const spinner = createSpinner("Scanning source files...").start();
  try {
    const result = await client.rescan();
    const parts: string[] = [];
    parts.push(`${GREEN}✓${RESET} Scan complete in ${result.duration_ms}ms`);
    parts.push(`  ${BOLD}Files scanned:${RESET} ${result.files_scanned}`);
    parts.push(`  ${BOLD}Files skipped:${RESET} ${result.files_skipped} ${DIM}(unchanged)${RESET}`);
    if (result.files_removed > 0) {
      parts.push(`  ${BOLD}Files removed:${RESET} ${result.files_removed}`);
    }
    parts.push(`  ${BOLD}Symbols found:${RESET} ${result.symbols_found}`);
    if (result.source_chunks_found != null && result.source_chunks_found > 0) {
      parts.push(`  ${BOLD}Source chunks:${RESET} ${result.source_chunks_found}`);
    }
    if (Object.keys(result.languages).length > 0) {
      const langs = Object.entries(result.languages)
        .sort(([, a], [, b]) => b - a)
        .map(([lang, count]) => `${lang}: ${count}`)
        .join(", ");
      parts.push(`  ${BOLD}Languages:${RESET} ${langs}`);
    }
    spinner.succeed(parts.join("\n"));
  } catch (error) {
    spinner.clear();
    throw error;
  }
}

export function coverageCommand(
  client: WorkerClient,
  opts?: { uncovered?: boolean; file?: string },
): Promise<void> {
  return client
    .coverageReport({
      filePath: opts?.file,
      limit: opts?.uncovered ? 100 : 50,
    })
    .then((report) => {
      emit(report, (value) =>
        formatCoverage(value, {
          showUncovered: opts?.uncovered,
          filePath: opts?.file,
        }),
      );
    });
}
