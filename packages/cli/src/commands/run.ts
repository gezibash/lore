import type { RunOutcome, RunSummary, WorkerClient } from "@lore/worker";
import { emit } from "../output.ts";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

/** `lr=0.003` → ["lr", "0.003"]. The first `=` splits, so a value may hold one. */
export function parseKeyValue(raw: string): [string, string] {
  const idx = raw.indexOf("=");
  if (idx <= 0) {
    throw new Error(`Expected key=value, got '${raw}'`);
  }
  return [raw.slice(0, idx).trim(), raw.slice(idx + 1).trim()];
}

export function parseParams(values: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  for (const raw of values) {
    const [key, value] = parseKeyValue(raw);
    params[key] = value;
  }
  return params;
}

export function parseMetrics(values: string[]): Record<string, number> {
  const metrics: Record<string, number> = {};
  for (const raw of values) {
    const [key, value] = parseKeyValue(raw);
    const parsed = Number(value);
    // A metric that is not a number cannot be compared against the run before
    // it, which is the only reason to record it.
    if (!Number.isFinite(parsed)) {
      throw new Error(`Metric '${key}' must be a number, got '${value}'`);
    }
    metrics[key] = parsed;
  }
  return metrics;
}

export function parseOutcome(raw: string | undefined): RunOutcome | undefined {
  if (raw === undefined) return undefined;
  if (raw === "success" || raw === "failure" || raw === "aborted") return raw;
  throw new Error(`Invalid --outcome '${raw}'. Use success, failure or aborted.`);
}

function outcomeLabel(outcome: RunOutcome): string {
  if (outcome === "success") return `${GREEN}success${RESET}`;
  if (outcome === "failure") return `${RED}failure${RESET}`;
  return `${YELLOW}aborted${RESET}`;
}

function pairs(record: Record<string, string | number>): string {
  return Object.entries(record)
    .map(([key, value]) => `${key}=${value}`)
    .join(" ");
}

export async function runLogCommand(
  client: WorkerClient,
  name: string,
  opts: {
    params: string[];
    metrics: string[];
    artifacts: string[];
    note?: string;
    outcome?: string;
    narrative?: string;
  },
): Promise<void> {
  const run = await client.runLog(name, {
    params: parseParams(opts.params),
    metrics: parseMetrics(opts.metrics),
    artifacts: opts.artifacts,
    note: opts.note,
    outcome: parseOutcome(opts.outcome),
    narrative: opts.narrative,
  });

  emit(run, (value) => {
    const lines = [`Recorded ${BOLD}${value.name}${RESET} ${outcomeLabel(value.outcome)}`];
    lines.push(`${DIM}  ${value.id}${RESET}`);
    if (value.narrative) lines.push(`${DIM}  narrative ${value.narrative}${RESET}`);
    return lines.join("\n");
  });
}

function formatRunLine(run: RunSummary): string {
  const parts = [`${BOLD}${run.name}${RESET}`, outcomeLabel(run.outcome)];
  if (Object.keys(run.metrics).length > 0) parts.push(pairs(run.metrics));
  return `${run.created_at.slice(0, 16).replace("T", " ")}  ${parts.join("  ")}\n${DIM}  ${run.id}${RESET}`;
}

export async function runListCommand(
  client: WorkerClient,
  opts: { name?: string; since?: string; limit?: number },
): Promise<void> {
  const runs = await client.runList(opts);
  emit(runs, (value) =>
    value.length === 0 ? `${DIM}No runs recorded.${RESET}` : value.map(formatRunLine).join("\n"),
  );
}

export async function runShowCommand(client: WorkerClient, id: string): Promise<void> {
  const run = await client.runShow(id);
  emit(run, (value) => {
    const lines = [`${BOLD}${value.name}${RESET}  ${outcomeLabel(value.outcome)}`];
    lines.push(`${DIM}${value.id} · ${value.created_at}${RESET}`);
    if (Object.keys(value.params).length > 0) lines.push(`\nparams    ${pairs(value.params)}`);
    if (Object.keys(value.metrics).length > 0) lines.push(`metrics   ${pairs(value.metrics)}`);
    if (value.artifacts.length > 0) lines.push(`artifacts ${value.artifacts.join(", ")}`);
    if (value.note) lines.push(`note      ${value.note}`);
    // Provenance is the reason a run is stored here rather than in a scratch
    // file: it says which state of the code produced these numbers.
    lines.push("");
    if (value.narrative) lines.push(`${DIM}narrative ${value.narrative}${RESET}`);
    if (value.git_head) lines.push(`${DIM}git       ${value.git_head.slice(0, 12)}${RESET}`);
    if (value.lore_commit_id) lines.push(`${DIM}lore      ${value.lore_commit_id}${RESET}`);
    return lines.join("\n");
  });
}
