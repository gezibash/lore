import type { WorkerClient } from "@lore/worker";
import { emit, isJsonOutput } from "../output.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";

function padRight(text: string, width: number): string {
  return text.padEnd(width);
}

function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
  return String(n);
}

function usd(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value > 0 && value < 0.01) return "<$0.01";
  return `$${value.toFixed(2)}`;
}

/**
 * Turn "2w", "3d" or "12h" into a timestamp. Anything else is passed through,
 * so an ISO date works as well.
 */
function parseSince(since: string | undefined): string | undefined {
  if (!since) return undefined;
  const match = /^(\d+)\s*([hdw])$/i.exec(since.trim());
  if (!match) return since;
  const amount = Number(match[1]);
  const hours = { h: 1, d: 24, w: 168 }[match[2]!.toLowerCase() as "h" | "d" | "w"];
  return new Date(Date.now() - amount * hours * 3600_000).toISOString();
}

export async function usageCommand(
  client: WorkerClient,
  options: { since?: string; all?: boolean; by?: string },
): Promise<void> {
  const reports = await client.usageReport({ since: parseSince(options.since), all: options.all });

  if (isJsonOutput()) {
    emit(reports);
    return;
  }

  if (reports.every((report) => report.lines.length === 0)) {
    console.log(
      `${DIM}No AI calls recorded yet. Usage is recorded from now on, not backfilled.${RESET}`,
    );
    return;
  }

  const groupBy =
    options.by === "operation" ? "operation" : options.by === "kind" ? "kind" : "model";

  for (const report of reports) {
    const total = report.lines.reduce(
      (sum, line) => ({
        calls: sum.calls + line.calls,
        input: sum.input + line.input_tokens,
        output: sum.output + line.output_tokens,
        // A single unpriced model makes the whole total a floor, not a figure.
        cost: line.cost_usd === undefined ? sum.cost : (sum.cost ?? 0) + line.cost_usd,
        partial: sum.partial || line.cost_usd === undefined,
      }),
      { calls: 0, input: 0, output: 0, cost: undefined as number | undefined, partial: false },
    );

    console.log(`${BOLD}${CYAN}${report.lore}${RESET}`);

    const grouped = new Map<
      string,
      { calls: number; input: number; output: number; cost?: number; partial: boolean }
    >();
    for (const line of report.lines) {
      const key = line[groupBy];
      const prior = grouped.get(key) ?? {
        calls: 0,
        input: 0,
        output: 0,
        cost: undefined,
        partial: false,
      };
      grouped.set(key, {
        calls: prior.calls + line.calls,
        input: prior.input + line.input_tokens,
        output: prior.output + line.output_tokens,
        cost: line.cost_usd === undefined ? prior.cost : (prior.cost ?? 0) + line.cost_usd,
        partial: prior.partial || line.cost_usd === undefined,
      });
    }

    console.log(
      `${DIM}${padRight(groupBy.toUpperCase(), 28)}${padLeft("CALLS", 7)}${padLeft("IN", 9)}${padLeft("OUT", 9)}${padLeft("COST", 10)}${RESET}`,
    );
    for (const [key, row] of [...grouped].sort(
      (a, b) => b[1].input + b[1].output - (a[1].input + a[1].output),
    )) {
      const cost =
        row.partial && row.cost === undefined ? "—" : `${row.partial ? "≥" : ""}${usd(row.cost)}`;
      console.log(
        `${padRight(key, 28)}${DIM}${padLeft(String(row.calls), 7)}${padLeft(tokens(row.input), 9)}${padLeft(tokens(row.output), 9)}${RESET}${padLeft(cost, 10)}`,
      );
    }

    const totalCost =
      total.partial && total.cost === undefined
        ? "—"
        : `${total.partial ? "≥" : ""}${usd(total.cost)}`;
    console.log(
      `${BOLD}${padRight("total", 28)}${padLeft(String(total.calls), 7)}${padLeft(tokens(total.input), 9)}${padLeft(tokens(total.output), 9)}${padLeft(totalCost, 10)}${RESET}`,
    );
    if (report.first_seen) {
      console.log(`${DIM}since ${report.first_seen.slice(0, 10)}${RESET}`);
    }
    if (total.partial) {
      console.log(`${DIM}≥ means some models had no published price; tokens are complete.${RESET}`);
    }
    console.log();
  }
}
