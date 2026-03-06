import type {
  ConceptRow,
  ExecutiveSummary,
  NarrativeRow,
  LsResult,
  QueryResult,
  RecallSection,
  RecallResult,
  RegistryEntry,
  StatusResult,
} from "@lore/sdk";
import {
  formatLs as formatLsMarkdown,
  formatStatus as formatStatusMarkdown,
  renderNarrativeWithCitations,
  renderProvenance,
  timeAgo,
} from "@lore/sdk";

export type RenderRoute = "cli" | "mcp" | "http";
export type RenderFormat = "plain" | "markdown" | "json";

export interface RenderOptions {
  route?: RenderRoute;
  format?: RenderFormat;
  prettyJson?: boolean;
}

export interface RenderLsOptions extends RenderOptions {
  groupBy?: "cluster";
}

export interface RenderAskOptions {
  includeSources?: boolean;
  route?: Extract<RenderRoute, "cli" | "mcp">;
}

export type { RecallSection };

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const COL_GAP = "  ";

function resolveFormat(opts?: RenderOptions): RenderFormat {
  if (opts?.format) return opts.format;
  const route = opts?.route ?? "cli";
  if (route === "mcp") return "markdown";
  if (route === "http") return "json";
  return "plain";
}

function toJson(value: unknown, opts?: RenderOptions): string {
  return JSON.stringify(value, null, opts?.prettyJson === false ? 0 : 2);
}

function pad(str: string, width: number): string {
  return str.padEnd(width);
}

function visibleLength(str: string): number {
  return str.replace(ANSI_RE, "").length;
}

function padVisible(str: string, width: number): string {
  const len = visibleLength(str);
  if (len >= width) return str;
  return str + " ".repeat(width - len);
}

function trendArrow(delta?: number | null): string {
  if (delta == null || !Number.isFinite(delta)) return "";
  if (delta > 1e-6) return `${RED}↑${RESET}`;
  if (delta < -1e-6) return `${GREEN}↓${RESET}`;
  return "";
}

function trendBadge(delta?: number | null): string {
  if (delta == null || !Number.isFinite(delta)) return "";
  const magnitude = `${Math.abs(delta * 100).toFixed(1)}%`;
  if (delta > 1e-6) return `${RED}↑ ${magnitude}${RESET}`;
  if (delta < -1e-6) return `${GREEN}↓ ${magnitude}${RESET}`;
  return "";
}

function stalenessLabel(value: number | null): string {
  if (value == null) return "—";
  if (value > 0.5) return `${RED}high${RESET}`;
  if (value > 0.3) return `${YELLOW}medium${RESET}`;
  return `${GREEN}low${RESET}`;
}

function normalizedResidual(raw: number | null): number | null {
  if (raw == null || !Number.isFinite(raw)) return null;
  return Math.min(1, Math.max(0, raw / 2));
}

function residualLabel(normalized: number | null): string {
  if (normalized == null) return "—";
  const text = `${(normalized * 100).toFixed(0)}%`;
  if (normalized <= 0.35) return `${GREEN}${text}${RESET}`;
  if (normalized <= 0.75) return `${YELLOW}${text}${RESET}`;
  return `${RED}${text}${RESET}`;
}

function compactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

type StaleSeverity = "none" | "low" | "medium" | "high";

function staleSeverity(stale: number, total: number): { level: StaleSeverity; ratio: number } {
  if (stale <= 0) return { level: "none", ratio: 0 };
  const ratio = total > 0 ? stale / total : 0;
  if (ratio >= 0.2 || stale >= 20) return { level: "high", ratio };
  if (ratio >= 0.05 || stale >= 5) return { level: "medium", ratio };
  return { level: "low", ratio };
}

function staleLabel(stale: number, total: number): string {
  const sev = staleSeverity(stale, total);
  if (sev.level === "none") return ` ${GREEN}✓${RESET}`;
  const ratio = `${(sev.ratio * 100).toFixed(0)}%`;
  if (sev.level === "low") return ` ${DIM}~ ${compactCount(stale)} stale (${ratio})${RESET}`;
  if (sev.level === "medium") return ` ${YELLOW}⚠ ${compactCount(stale)} stale (${ratio})${RESET}`;
  return ` ${RED}⚠ ${compactCount(stale)} stale (${ratio})${RESET}`;
}

function renderClaimBlock(summary: ExecutiveSummary | null | undefined): string[] {
  if (!summary?.claims || summary.claims.length === 0) return [];
  return [
    "",
    "## Attribution",
    ...summary.claims.map((claim) => {
      const confidence = `${(claim.confidence * 100).toFixed(0)}%`;
      const lowConfidence = claim.confidence < 0.5 ? " ⚠ low confidence" : "";
      const staleTag =
        claim.max_staleness != null && claim.max_staleness > 0.4
          ? ` — stale (${(claim.max_staleness * 100).toFixed(0)}%)`
          : "";
      return `[${confidence}] ${claim.text} [${claim.source_concepts.join(", ")}]${lowConfidence}${staleTag}`;
    }),
  ];
}

function renderSummaryNarrative(result: QueryResult): string {
  const summary = result.executive_summary;
  if (!summary) {
    return result.results[0]?.summary?.trim() || "No matching concepts.";
  }
  if (summary.kind === "uncertain") {
    return summary.uncertainty_reason
      ? `Uncertain: ${summary.uncertainty_reason}`
      : "Uncertain";
  }
  if (summary.narrative.trim().length === 0) {
    return "No matching concepts.";
  }
  return summary.citations.length > 0
    ? renderNarrativeWithCitations(summary.narrative, summary.citations, {
        exactness: result.meta.grounding.exactness_detected,
      })
    : summary.narrative;
}

function renderSummaryProvenance(summary: ExecutiveSummary | null | undefined): string | null {
  if (!summary) return null;
  const provenance = renderProvenance(summary).trim();
  return provenance.length > 0 ? provenance : null;
}

function bindCommand(route: Extract<RenderRoute, "cli" | "mcp">): string {
  return route === "cli" ? "`lore sys concept bind <concept> <symbol>`" : "`bind(concept, symbol)`";
}

function recallCommand(route: Extract<RenderRoute, "cli" | "mcp">, resultId: string): string {
  return route === "cli" ? `\`lore recall ${resultId}\`` : "`recall(result_id)`";
}

function scoreCommand(route: Extract<RenderRoute, "cli" | "mcp">, resultId: string): string {
  return route === "cli" ? `\`lore score ${resultId} <1-5>\`` : "`score(result_id, 1-5)`";
}

function trailCommand(
  route: Extract<RenderRoute, "cli" | "mcp">,
  narrative: string | null,
): string | null {
  if (!narrative) return null;
  return route === "cli" ? `\`lore trail ${narrative}\`` : `\`trail(${narrative})\``;
}

function showFollowUpCommand(
  route: Extract<RenderRoute, "cli" | "mcp">,
  concept: string,
  resultId?: string,
): string {
  if (route === "cli") {
    const suffix = resultId ? ` --from-result ${resultId}` : "";
    return `\`lore show ${concept}${suffix}\``;
  }
  const resultArg = resultId ? `, result_id=\"${resultId}\"` : "";
  return `\`show(concept=\"${concept}\"${resultArg})\``;
}

function recallFollowUpCommand(
  route: Extract<RenderRoute, "cli" | "mcp">,
  resultId: string,
  section: RecallSection,
): string {
  if (route === "cli") {
    return `\`lore recall ${resultId} --section ${section}\``;
  }
  return `\`recall(result_id=\"${resultId}\", section=\"${section}\")\``;
}

function trailFollowUpCommand(
  route: Extract<RenderRoute, "cli" | "mcp">,
  narrative: string,
  resultId?: string,
): string {
  if (route === "cli") {
    const suffix = resultId ? ` --from-result ${resultId}` : "";
    return `\`lore trail ${narrative}${suffix}\``;
  }
  const resultArg = resultId ? `, result_id=\"${resultId}\"` : "";
  return `\`trail(narrative=\"${narrative}\"${resultArg})\``;
}

function ingestFollowUpCommand(route: Extract<RenderRoute, "cli" | "mcp">): string {
  return route === "cli" ? "`lore ingest`" : "`ingest()`";
}

function renderBindingNudge(
  summary: ExecutiveSummary | null | undefined,
  route: Extract<RenderRoute, "cli" | "mcp">,
): string[] {
  const unboundSymbols = summary?.unbound_source_symbols;
  if (!unboundSymbols || unboundSymbols.length === 0) return [];
  return [
    "",
    `⚠ Used authoritative source-chunk grounding for: ${unboundSymbols.join(", ")}. These symbols have no concept bindings — future retrieval will rely on embedding similarity. Bind them now: ${bindCommand(route)}`,
  ];
}

function renderNextActions(
  result: QueryResult,
  route: Extract<RenderRoute, "cli" | "mcp">,
): string[] {
  if (!result.next_actions || result.next_actions.length === 0) return [];
  const lines: string[] = ["", "## Next"];
  for (const action of result.next_actions) {
    let command: string | null = null;
    if (action.kind === "show" && action.concept) {
      command = showFollowUpCommand(route, action.concept, result.result_id);
    } else if (action.kind === "recall" && result.result_id && action.section) {
      command = recallFollowUpCommand(route, result.result_id, action.section);
    } else if (action.kind === "trail" && action.narrative) {
      command = trailFollowUpCommand(route, action.narrative, result.result_id);
    } else if (action.kind === "ingest") {
      command = ingestFollowUpCommand(route);
    }
    if (!command) continue;
    const prefix = action.primary ? "primary: " : "";
    lines.push(`- ${prefix}${command} — ${action.reason}`);
  }
  return lines.length > 2 ? lines : [];
}

function renderJournalTrail(groups: NonNullable<QueryResult["journal_results"]>): string[] {
  const lines: string[] = ["", "## Investigation Trail"];
  for (const group of groups) {
    const age = timeAgo(group.opened_at);
    const matched = group.matched_entries.length;
    const entryWord = group.total_entries === 1 ? "entry" : "entries";
    lines.push(`- **${group.narrative_name}** (${age}) — ${group.narrative_intent}`);
    lines.push(
      `  ${group.narrative_status} · ${group.total_entries} ${entryWord} (${matched} matched)`,
    );
    for (let i = 0; i < group.matched_entries.length; i++) {
      const entry = group.matched_entries[i]!;
      const statusTag = entry.status ? `[${entry.status}] ` : "";
      const posTag = entry.entry_index > 0 ? `(${entry.entry_index}/${group.total_entries}) ` : "";
      const preview =
        entry.content.length > 200
          ? `${entry.content.slice(0, 200).trim()}...`
          : entry.content.trim();
      lines.push(`  ${i + 1}. ${statusTag}${posTag}"${preview}"`);
    }
    if (group.other_topics.length > 0) {
      lines.push(`  Also covers: ${group.other_topics.join(", ")}`);
    }
  }
  return lines;
}

function renderSources(result: QueryResult): string[] {
  const lines: string[] = ["", "## Sources"];
  if (result.results.length === 0 && (!result.web_results || result.web_results.length === 0)) {
    lines.push("No sources available.");
    return lines;
  }

  for (const item of result.results) {
    const files = item.meta.files.length > 0 ? item.meta.files.join(", ") : "no file refs";
    lines.push(`- ${item.concept} (score ${(item.meta.score * 100).toFixed(1)}%)`);
    lines.push(`  updated: ${item.meta.last_updated ? timeAgo(item.meta.last_updated) : "unknown"}`);
    if (item.meta.last_narrative) {
      const narrativeAge = item.meta.last_narrative.closed_at
        ? timeAgo(item.meta.last_narrative.closed_at)
        : "";
      lines.push(
        `  last narrative: ${item.meta.last_narrative.name} (${narrativeAge}) — "${item.meta.last_narrative.intent}"`,
      );
    }
    lines.push(`  files: ${files}`);
    lines.push(`  chunk: ${item.meta.chunk_id}`);
    if (item.meta.cluster != null) {
      lines.push(`  cluster: ${item.meta.cluster}`);
    }
    if (item.meta.cluster_summary) {
      lines.push(`  cluster summary: ${item.meta.cluster_summary}`);
    }
    if (item.meta.cluster_peers && item.meta.cluster_peers.length > 0) {
      lines.push(`  cluster peers: ${item.meta.cluster_peers.join(", ")}`);
    }
    if (item.meta.relations && item.meta.relations.length > 0) {
      const relParts = item.meta.relations.map((rel) => {
        const arrow = rel.direction === "outbound" ? "→" : "←";
        return `${arrow} ${rel.concept} (${rel.type}, ${rel.weight})`;
      });
      lines.push(`  relations: ${relParts.join(", ")}`);
    }
    if (item.meta.neighbors_2hop && item.meta.neighbors_2hop.length > 0) {
      const hop2Parts = item.meta.neighbors_2hop.map((neighbor) => {
        const weight =
          neighbor.weight != null ? `, ${(neighbor.weight * 100).toFixed(0)}%` : "";
        return `${neighbor.concept} (${neighbor.path}${weight})`;
      });
      lines.push(`  2-hop neighbors: ${hop2Parts.join(", ")}`);
    }
    if (item.meta.bindings && item.meta.bindings.length > 0) {
      const top = item.meta.bindings.slice(0, 10);
      const bindParts = top.map((binding) => {
        return `${binding.symbol} (${binding.kind}, ${binding.file}:${binding.line})`;
      });
      const suffix =
        item.meta.bindings.length > 10 ? ` (+${item.meta.bindings.length - 10} more)` : "";
      lines.push(`  bindings: ${bindParts.join(", ")}${suffix}`);
    }
    if (item.warning) {
      lines.push(`  warning: ${item.warning}`);
    }
  }

  if (result.web_results && result.web_results.length > 0) {
    lines.push("", "## Web Sources");
    for (const item of result.web_results) {
      lines.push(`- ${item.title} (${item.source})`);
      lines.push(`  ${item.url}`);
    }
  }

  return lines;
}

function renderResultFooter(
  result: QueryResult,
  route: Extract<RenderRoute, "cli" | "mcp">,
): string[] {
  if (!result.result_id) return [];

  const timing = result.meta.generated_in ? ` · ${result.meta.generated_in}` : "";
  const trailNarrative =
    result.journal_results && result.journal_results.length === 1
      ? result.journal_results[0]!.narrative_name
      : null;
  const trailHint = trailCommand(route, trailNarrative);
  const trailText = trailHint ? `, ${trailHint} for the full investigation trail` : "";
  return [
    "",
    `Result ID: ${result.result_id}${timing} — use ${recallCommand(route, result.result_id)} for full sources, ${scoreCommand(route, result.result_id)} to rate this answer${trailText}.`,
  ];
}

export function renderAsk(result: QueryResult, opts?: RenderAskOptions): string {
  const route = opts?.route ?? "cli";
  const lines: string[] = [renderSummaryNarrative(result)];
  const provenance = renderSummaryProvenance(result.executive_summary);
  if (provenance) {
    lines.push("", provenance);
  }
  lines.push(...renderClaimBlock(result.executive_summary));
  lines.push(...renderBindingNudge(result.executive_summary, route));
  lines.push(...renderNextActions(result, route));
  if (opts?.includeSources) {
    lines.push(...renderSources(result));
  }
  if (result.journal_results && result.journal_results.length > 0) {
    lines.push(...renderJournalTrail(result.journal_results));
  }
  lines.push(...renderResultFooter(result, route));
  return lines.join("\n").trimEnd();
}

export function renderAskBrief(result: QueryResult, opts?: Omit<RenderAskOptions, "includeSources">): string {
  return renderAsk(result, { ...opts, includeSources: false });
}

export function renderRecall(recalled: RecallResult, section: RecallSection = "full"): string {
  const result = recalled.result;
  const scoreStr = recalled.score != null ? `scored: ${recalled.score}/5` : "unscored";
  const age = timeAgo(recalled.created_at);
  const lines: string[] = [`Recalled: "${recalled.query_text}" (${scoreStr}, ${age})`];

  const showSources = section === "sources" || section === "full";
  const showJournal = section === "journal" || section === "full";
  const showSymbols = section === "symbols" || section === "full";

  if (showSources) {
    lines.push(...renderSources(result));
  }

  if (showJournal && result.journal_results && result.journal_results.length > 0) {
    lines.push(...renderJournalTrail(result.journal_results));
  }

  if (showSymbols && result.symbol_results && result.symbol_results.length > 0) {
    lines.push("", "## Symbols");
    for (const sym of result.symbol_results) {
      const boundTag = sym.bound_concepts?.length ? ` → [${sym.bound_concepts.join(", ")}]` : "";
      lines.push(`- ${sym.kind} ${sym.qualified_name} (${sym.file_path}:${sym.line_start})${boundTag}`);
    }
  }

  return lines.join("\n").trimEnd();
}

function renderStatusPlain(result: StatusResult): string {
  const lines: string[] = [];

  const healthColor =
    result.health === "good" ? GREEN : result.health === "degrading" ? YELLOW : RED;
  lines.push(`${BOLD}Health:${RESET} ${healthColor}${result.health}${RESET}`);
  const debtTrend = trendBadge(result.debt_delta);
  lines.push(debtTrend ? `${result.summary} ${debtTrend}` : result.summary);
  if (result.state_distance != null) {
    lines.push(`${DIM}S_dist: ${(result.state_distance * 100).toFixed(0)}% (epistemological gap)${RESET}`);
  }

  if (result.coverage) {
    const pct = (result.coverage.ratio * 100).toFixed(0);
    lines.push(
      `${DIM}coverage: ${pct}% (${compactCount(result.coverage.exported_covered)}/${compactCount(result.coverage.exported_total)} exported symbols)${RESET}`,
    );
    if (result.coverage.total_bindings != null) {
      const confColor =
        result.coverage.avg_confidence >= 0.7
          ? GREEN
          : result.coverage.avg_confidence >= 0.4
            ? YELLOW
            : RED;
      lines.push(
        `${DIM}bindings: ${compactCount(result.coverage.total_bindings)} (ref: ${compactCount(result.coverage.by_type.ref)}, mention: ${compactCount(result.coverage.by_type.mention)})  avg confidence: ${confColor}${(result.coverage.avg_confidence * 100).toFixed(0)}%${RESET}${RESET}`,
      );
      lines.push(
        `${DIM}concepts bound: ${compactCount(result.coverage.concepts_with_bindings)}/${compactCount(result.coverage.concepts_total)}${RESET}`,
      );
      if (result.coverage.drifted > 0) {
        lines.push(`${YELLOW}⚠ ${compactCount(result.coverage.drifted)} drifted binding(s)${RESET}`);
      }
    }
  }

  if (result.lake) {
    const l = result.lake;
    const codeAge = l.last_code_indexed_at ? timeAgo(l.last_code_indexed_at) : "never";
    const docAge = l.last_doc_indexed_at ? timeAgo(l.last_doc_indexed_at) : "never";
    const codeSev = staleSeverity(l.stale_source_files, Math.max(1, l.source_files));
    const docSev = staleSeverity(l.stale_doc_files, Math.max(1, l.doc_chunks));
    const codeStaleStr = staleLabel(l.stale_source_files, Math.max(1, l.source_files));
    const docStaleStr = staleLabel(l.stale_doc_files, Math.max(1, l.doc_chunks));
    lines.push(`\n${BOLD}LAKE${RESET}`);
    lines.push(
      `  ${DIM}code   ${RESET} ${compactCount(l.source_chunks)} symbols · ${compactCount(l.source_files)} files · ${codeAge}${codeStaleStr}`,
    );
    lines.push(
      `  ${DIM}docs   ${RESET} ${compactCount(l.doc_chunks)} files · ${docAge}${docStaleStr}`,
    );
    lines.push(`  ${DIM}journal${RESET} ${compactCount(l.journal_entries)} entries`);
    if (codeSev.level === "high" || codeSev.level === "medium" || docSev.level === "high" || docSev.level === "medium") {
      lines.push(`  ${YELLOW}run lore ingest to refresh${RESET}`);
    } else if (codeSev.level === "low" || docSev.level === "low") {
      lines.push(`  ${DIM}minor index drift — ingest when convenient${RESET}`);
    }
  }

  if (result.priorities.length > 0) {
    lines.push(`\n${BOLD}PRIORITIES${RESET}`);
    for (const p of result.priorities) {
      lines.push(`  ${YELLOW}${p.concept}${RESET}: ${p.action} — ${p.reason}`);
      if (p.last_narrative) {
        const narrativeAge = p.last_narrative.closed_at ? timeAgo(p.last_narrative.closed_at) : "unknown";
        lines.push(`    ${DIM}last narrative: ${p.last_narrative.name} (${narrativeAge}) — "${p.last_narrative.intent}"${RESET}`);
      }
      if (p.changed_at) {
        lines.push(`    ${DIM}last changed: ${timeAgo(p.changed_at)}${RESET}`);
      }
    }
  }

  if (result.concept_health && result.concept_health.top_stale.length > 0) {
    lines.push(`\n${BOLD}TOP STALE CONCEPTS${RESET}`);
    for (const concept of result.concept_health.top_stale.slice(0, 3)) {
      const critical = concept.critical ? ` ${RED}(critical)${RESET}` : "";
      lines.push(
        `  ${CYAN}${concept.concept}${RESET}: ${(concept.final_stale * 100).toFixed(0)}%${critical}`,
      );
    }
  }

  if (result.active_narratives.length > 0) {
    lines.push(`\n${BOLD}ACTIVE NARRATIVES${RESET}`);
    for (const d of result.active_narratives) {
      const theta = d.theta != null ? `θ=${d.theta.toFixed(1)}°` : "θ=—";
      lines.push(`  ${CYAN}${d.name}${RESET}  ·  ${compactCount(d.entry_count)} entries  ·  ${theta}`);
    }
  }

  if (result.dangling_narratives.length > 0) {
    lines.push(`\n${BOLD}DANGLING NARRATIVES${RESET}`);
    for (const d of result.dangling_narratives) {
      lines.push(`  ${YELLOW}${d.name}${RESET}  ·  ${compactCount(d.age_days)} days old  ·  ${d.action}`);
    }
  }

  if (result.suggestions.length > 0) {
    lines.push(`\n${BOLD}SUGGESTIONS${RESET}`);
    for (const s of result.suggestions) {
      if (s.action === "connect" && s.concepts.length >= 2) {
        lines.push(`  Connect ${s.concepts[0]} ↔ ${s.concepts[1]} — ${s.reason}`);
      } else {
        lines.push(`  ${s.reason}`);
      }
    }
  }

  return lines.join("\n");
}

function renderLsPlain(
  loreMind: { name: string } & RegistryEntry,
  concepts: ConceptRow[],
  openNarratives: NarrativeRow[],
  opts: {
    debt: number;
    trend: string;
    debtDelta?: number | null;
    conceptTrends?: Array<{
      concept_id: string;
      residual_delta: number | null;
      staleness_delta: number | null;
    }>;
    groupBy?: "cluster";
    conceptSymbolCounts?: Record<string, number>;
  },
): string {
  const lines: string[] = [];

  const debt = `${opts.debt.toFixed(1)}%`;
  lines.push(
    `${BOLD}${loreMind.name}${RESET}  ·  ${compactCount(concepts.length)} concepts  ·  debt ${debt}`,
  );
  lines.push("");

  if (concepts.length > 0) {
    const trends = new Map(
      (opts.conceptTrends ?? []).map((trendRow) => [trendRow.concept_id, trendRow]),
    );
    const sortedConcepts = [...concepts].sort((a, b) => {
      const residualDiff = (b.residual ?? 0) - (a.residual ?? 0);
      if (Math.abs(residualDiff) > 1e-9) return residualDiff;
      const stalenessDiff = (b.staleness ?? 0) - (a.staleness ?? 0);
      if (Math.abs(stalenessDiff) > 1e-9) return stalenessDiff;
      return a.name.localeCompare(b.name);
    });
    const residualWidth = 14;
    const stalenessWidth = 14;
    const symbolsWidth = 8;

    const renderConceptRow = (
      concept: ConceptRow,
      nameWidth: number,
      includeCluster: boolean,
    ): string => {
      const trendRow = trends.get(concept.id);
      const normResidual = normalizedResidual(concept.residual);
      const residual = residualLabel(normResidual);
      const residualArrow = trendArrow(trendRow?.residual_delta);
      const residualCell = residualArrow ? `${residual} ${residualArrow}` : residual;
      const staleness = stalenessLabel(concept.staleness ?? null);
      const stalenessArrow = trendArrow(trendRow?.staleness_delta);
      const stalenessCell = stalenessArrow ? `${staleness} ${stalenessArrow}` : staleness;
      const symCount = opts.conceptSymbolCounts?.[concept.id] ?? 0;
      const symbolsCell = symCount > 0 ? compactCount(symCount) : "—";
      if (!includeCluster) {
        return `${[
          pad(concept.name, nameWidth),
          padVisible(residualCell, residualWidth),
          padVisible(stalenessCell, stalenessWidth),
          pad(symbolsCell, symbolsWidth),
        ].join(COL_GAP)}`;
      }
      const clusterWidth = 10;
      const cluster = String(concept.cluster ?? "—");
      return `${[
        pad(concept.name, nameWidth),
        padVisible(residualCell, residualWidth),
        padVisible(stalenessCell, stalenessWidth),
        pad(symbolsCell, symbolsWidth),
        pad(cluster, clusterWidth),
      ].join(COL_GAP)}`;
    };

    if (opts.groupBy === "cluster") {
      const grouped = new Map<string, ConceptRow[]>();
      for (const concept of sortedConcepts) {
        const key = concept.cluster == null ? "—" : String(concept.cluster);
        const bucket = grouped.get(key);
        if (bucket) bucket.push(concept);
        else grouped.set(key, [concept]);
      }
      const clusterKeys = [...grouped.keys()].sort((a, b) => {
        if (a === "—") return 1;
        if (b === "—") return -1;
        return Number(a) - Number(b);
      });

      for (let i = 0; i < clusterKeys.length; i++) {
        const clusterKey = clusterKeys[i]!;
        const bucket = grouped.get(clusterKey)!;
        const groupTitle = clusterKey === "—" ? "UNCLUSTERED" : `CLUSTER ${clusterKey}`;
        const nameWidth = Math.max(8, ...bucket.map((c) => c.name.length)) + 2;
        lines.push(`${BOLD}${groupTitle}${RESET} ${DIM}(${compactCount(bucket.length)})${RESET}`);
        lines.push(
          `${DIM}${[
            pad("CONCEPT", nameWidth),
            pad("RESIDUAL", residualWidth),
            pad("STALENESS", stalenessWidth),
            pad("SYMBOLS", symbolsWidth),
          ].join(COL_GAP)}${RESET}`,
        );
        for (const concept of bucket) {
          lines.push(renderConceptRow(concept, nameWidth, false));
        }
        if (i < clusterKeys.length - 1) lines.push("");
      }
    } else {
      const nameWidth = Math.max(8, ...sortedConcepts.map((c) => c.name.length)) + 2;
      const clusterWidth = 10;
      lines.push(
        `${DIM}${[
          pad("CONCEPT", nameWidth),
          pad("RESIDUAL", residualWidth),
          pad("STALENESS", stalenessWidth),
          pad("SYMBOLS", symbolsWidth),
          pad("CLUSTER", clusterWidth),
        ].join(COL_GAP)}${RESET}`,
      );
      for (const concept of sortedConcepts) {
        lines.push(renderConceptRow(concept, nameWidth, true));
      }
    }
  }

  if (openNarratives.length > 0) {
    lines.push("");
    lines.push(`${BOLD}ACTIVE NARRATIVES${RESET}`);
    for (const d of openNarratives) {
      const theta = d.theta != null ? `θ=${d.theta.toFixed(1)}°` : "θ=—";
      lines.push(`${CYAN}${d.name}${RESET}  ·  ${compactCount(d.entry_count)} entries  ·  ${theta}`);
    }
  }

  return lines.join("\n");
}

export function renderStatus(result: StatusResult, opts?: RenderOptions): string {
  const format = resolveFormat(opts);
  if (format === "json") return toJson(result, opts);
  if (format === "markdown") return formatStatusMarkdown(result);
  return renderStatusPlain(result);
}

export function renderLs(result: LsResult, opts?: RenderLsOptions): string {
  const format = resolveFormat(opts);
  if (format === "json") return toJson(result, opts);
  if (format === "markdown") return formatLsMarkdown(result);
  return renderLsPlain(result.lore_mind, result.concepts, result.openNarratives, {
    debt: result.debt,
    trend: result.debt_trend,
    debtDelta: result.debt_delta,
    conceptTrends: result.concept_trends,
    groupBy: opts?.groupBy,
    conceptSymbolCounts: result.concept_symbol_counts,
  });
}
