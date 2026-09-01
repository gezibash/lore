import { readFileSync } from "node:fs";
import type { WorkerClient } from "@lore/worker";
import { formatAskCli } from "../formatters.ts";
import { emit, isJsonOutput } from "../output.ts";
import { createDraft, isInteractiveOutputEnabled } from "../tty.ts";

export async function queryCommand(
  client: WorkerClient,
  text: string,
  opts?: {
    search?: boolean;
    brief?: boolean;
    concise?: boolean;
    sources?: boolean;
    mode?: "arch" | "code";
    debug?: boolean;
    scopes?: string[];
  },
): Promise<void> {
  const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
  let draft: ReturnType<typeof createDraft> | null = null;
  let line: ReturnType<ReturnType<typeof createDraft>["addLine"]> | null = null;
  let currentMessage = "preparing models";
  let phaseStartedAtMs = Date.now();
  let ticker: ReturnType<typeof setInterval> | null = null;
  let frameIndex = 0;
  const interactive = isInteractiveOutputEnabled() && !isJsonOutput();

  const formatElapsed = (elapsedMs: number): string => `${(elapsedMs / 1000).toFixed(1)}s`;
  const renderProgress = (): void => {
    if (!line) return;
    const frame = FRAMES[frameIndex % FRAMES.length]!;
    frameIndex += 1;
    line.update(`${frame} ${currentMessage} ${formatElapsed(Date.now() - phaseStartedAtMs)}`);
  };

  if (interactive) {
    draft = createDraft();
    line = draft.addLine(`${FRAMES[0]} ${currentMessage} ${formatElapsed(0)}`);
    ticker = setInterval(() => {
      renderProgress();
    }, 120);
  }

  const updateSpinner = (message: string): void => {
    if (message === currentMessage) return;
    currentMessage = message;
    phaseStartedAtMs = Date.now();
    frameIndex = 0;
    renderProgress();
  };

  const stopSpinner = (): void => {
    if (ticker) {
      clearInterval(ticker);
      ticker = null;
    }
    if (!draft) return;
    draft.clear();
    draft.stop();
    draft = null;
    line = null;
  };

  try {
    const result = await client.query(text, {
      search: opts?.search,
      brief: opts?.brief,
      concise: opts?.concise,
      mode: opts?.mode,
      debug: opts?.debug,
      scopes: opts?.scopes,
      onProgress: updateSpinner,
    });
    stopSpinner();
    emit(result, (value) => formatAskCli(value, { includeSources: opts?.sources }));
    if (opts?.debug && !isJsonOutput()) {
      renderAskDebug((result as { debug_trace_path?: string }).debug_trace_path);
    }
  } catch (error) {
    stopSpinner();
    throw error;
  }
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";

/** Render the retrieval-pipeline trace: what ranked, what was expanded in,
 *  and what the model was actually shown. */
function renderAskDebug(tracePath: string | undefined): void {
  if (!tracePath) {
    console.log(`${DIM}debug: no trace path returned (older daemon? restart it)${RESET}`);
    return;
  }
  let events: Array<Record<string, unknown>>;
  try {
    events = readFileSync(tracePath, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch (error) {
    console.log(`${DIM}debug: could not read trace ${tracePath}: ${String(error)}${RESET}`);
    return;
  }
  const byStage = new Map<string, Record<string, unknown>>();
  for (const e of events) byStage.set(String(e.stage), e);
  const num = (v: unknown): string => (typeof v === "number" ? String(v) : "?");

  console.log(`\n${BOLD}── ask debug ──────────────────────────────────${RESET}`);

  const lanes = events.filter((e) => String(e.stage).startsWith("lane."));
  const laneParts = lanes.map((l) => {
    const name = String(l.stage).slice(5);
    return l.skipped
      ? `${name} ${DIM}skipped (${String(l.reason ?? "?")})${RESET}`
      : `${name} ${num(l.candidates)}`;
  });
  if (laneParts.length) console.log(`lanes     ${laneParts.join(" · ")}`);

  const fusion = byStage.get("fusion");
  const rerank = byStage.get("rerank.done");
  const final = byStage.get("results.final");
  const flow = [
    fusion && `fusion ${num(fusion.candidates)}`,
    rerank &&
      (rerank.applied
        ? `rerank ${num(rerank.candidates_count)}`
        : `rerank ${DIM}skipped (${String(rerank.reason ?? "?")})${RESET}`),
    final && `final ${num((final.items as unknown[] | undefined)?.length ?? final.count)}`,
  ].filter(Boolean);
  if (flow.length) console.log(`pipeline  ${flow.join(" → ")}`);

  const boost = byStage.get("boost.done");
  if (boost)
    console.log(
      `boost     ${num(boost.symbols_matched)} symbols matched, ${num(boost.concepts_boosted)} concepts boosted`,
    );
  const siblings = byStage.get("file_aware_siblings");
  if (siblings)
    console.log(
      `expand    file siblings +${num(siblings.added)} ${DIM}(${((siblings.files as string[]) ?? []).length} files)${RESET}`,
    );
  const callSites = byStage.get("call_site_expansion");
  if (callSites)
    console.log(
      `          call sites +${num(callSites.added)} ${DIM}(from ${((callSites.symbols as string[]) ?? []).length} pack symbols)${RESET}`,
    );

  const pack = byStage.get("pack");
  const packItems = (pack?.items as Array<Record<string, unknown>> | undefined) ?? [];
  if (pack) {
    console.log(
      `\n${BOLD}pack${RESET} — ${packItems.length} items, ${num(pack.total_chars)} chars (this is what the model saw)`,
    );
    for (const it of packItems) {
      const score = typeof it.score === "number" ? it.score.toFixed(2) : "  ? ";
      const trunc = it.truncated ? " ✂" : "";
      console.log(
        `  ${String(it.rank).padStart(2)}  ${score}  ${String(it.concept).slice(0, 44).padEnd(44)} ${DIM}${num(it.chars)}ch${trunc}${RESET}`,
      );
    }
  }

  const grounding = byStage.get("grounding.done");
  if (grounding)
    console.log(
      `\ngrounding exactness=${String(grounding.exactness_detected)} hits=${num(grounding.hits_total)} call_site_hits=${num(grounding.call_site_hits)}`,
    );
  const summary = byStage.get("summary.done");
  if (summary)
    console.log(
      `summary   ${num(summary.prompt_tokens)} prompt tok → ${num(summary.completion_tokens)} completion tok, ${num(summary.elapsed_ms_local)}ms`,
    );
  console.log(`${DIM}trace     ${tracePath}${RESET}`);
}
