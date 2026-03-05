import type {
  ConceptBindingSummary,
  ConceptHealthComputeResult,
  ConceptHealthExplainResult,
  ConceptRelationSummary,
  LsResult,
  ConceptRow,
  ConceptTagSummary,
  NarrativeRow,
  HealConceptsResult,
  QueryResult,
  RegistryEntry,
  StatusResult,
} from "@lore/worker";
import { renderLs as renderLsRoute, renderStatus as renderStatusRoute } from "@lore/rendering";
import { renderExecutiveSummary, timeAgo } from "@lore/worker";
import type {
  EnsureProjectMcpConfigResult,
  HarnessMcpConfigResult,
} from "./commands/mcp-config.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";

function compactCount(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

export function formatAskCli(
  result: QueryResult,
  opts?: {
    includeSources?: boolean;
  },
): string {
  const es = result.executive_summary;
  const summaryFallback = result.results[0]?.summary?.trim();
  const headline = es
    ? renderExecutiveSummary(es, { exactness: result.meta.grounding.exactness_detected })
    : summaryFallback && summaryFallback.length > 0
      ? summaryFallback
      : "No matching concepts.";

  const unboundSymbols = es?.unbound_source_symbols;
  const bindingNudge =
    unboundSymbols && unboundSymbols.length > 0
      ? `\n⚠ Used authoritative source-chunk grounding for: ${unboundSymbols.join(", ")}. ` +
        `These symbols have no concept bindings — future retrieval will rely on embedding similarity. ` +
        `Bind them now: \`lore bind <concept> <symbol>\``
      : "";

  if (!opts?.includeSources) return bindingNudge ? `${headline}\n${bindingNudge}` : headline;

  const lines: string[] = [headline];
  if (bindingNudge) lines.push(bindingNudge);
  lines.push("", "## Sources");
  if (result.results.length === 0 && (!result.web_results || result.web_results.length === 0)) {
    lines.push("No sources available.");
    return lines.join("\n").trimEnd();
  }

  for (const item of result.results) {
    const files = item.meta.files.length > 0 ? item.meta.files.join(", ") : "no file refs";
    lines.push(`- **${item.concept}** (score ${(item.meta.score * 100).toFixed(1)}%)`);
    lines.push(`  files: ${files}`);
    lines.push(`  chunk: ${item.meta.chunk_id}`);
  }

  if (result.web_results && result.web_results.length > 0) {
    lines.push("");
    lines.push("## Web Sources");
    for (const item of result.web_results) {
      lines.push(`- ${item.title} (${item.source})`);
      lines.push(`  ${item.url}`);
    }
  }

  return lines.join("\n").trimEnd();
}

export function formatLs(
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
  const result: LsResult = {
    lore_mind: loreMind,
    concepts,
    manifest: null,
    openNarratives,
    debt: opts.debt,
    debt_trend: opts.trend,
    debt_delta: opts.debtDelta,
    concept_trends: opts.conceptTrends?.map((trend) => ({
      ...trend,
      previous_residual: null,
      previous_staleness: null,
    })),
    concept_symbol_counts: opts.conceptSymbolCounts,
  };
  return renderLsRoute(result, { route: "cli", format: "plain", groupBy: opts.groupBy });
}

export function formatShow(conceptName: string, content: string | null): string {
  if (!content) return `${DIM}No content for concept '${conceptName}'${RESET}`;
  return `${BOLD}${conceptName}${RESET}\n\n${content}`;
}

export function formatHistory(
  conceptName: string,
  result: {
    concept: ConceptRow;
    history: Array<{
      id: string;
      version: number;
      createdAt: string;
      supersedes: string | null;
      supersededBy: string | null;
      content: string;
      narrative?: { name: string; intent: string; entryCount: number };
      drift?: number;
      journalSnippets?: string[];
      commit?: { id: string; message: string };
    }>;
  },
): string {
  const lines: string[] = [];

  // Concept header
  const c = result.concept;
  const residual = c.residual != null ? `${(c.residual * 100).toFixed(0)}%` : "—";
  const staleness =
    c.staleness != null
      ? c.staleness > 0.5
        ? `${RED}high${RESET}`
        : c.staleness > 0.3
          ? `${YELLOW}medium${RESET}`
          : `${GREEN}low${RESET}`
      : "—";
  const cluster = c.cluster != null ? `cluster ${c.cluster}` : "no cluster";
  lines.push(
    `${BOLD}${conceptName}${RESET}  ${DIM}(${cluster}, residual ${residual}, staleness ${staleness})${RESET}`,
  );
  lines.push("");

  // Versions newest-first
  const sorted = [...result.history].reverse();
  for (const entry of sorted) {
    const tag =
      entry.supersededBy == null ? `${GREEN}[active]${RESET}` : `${DIM}[superseded]${RESET}`;
    const viaStr = entry.narrative ? `  via narrative ${CYAN}"${entry.narrative.name}"${RESET}` : "";
    lines.push(`${BOLD}v${entry.version}${RESET}  ${tag}  ${timeAgo(entry.createdAt)}${viaStr}`);

    if (entry.narrative) {
      lines.push(`    ${DIM}intent:${RESET} ${entry.narrative.intent}`);
    }
    if (entry.drift != null) {
      lines.push(`    ${DIM}drift:${RESET} ${(entry.drift * 100).toFixed(0)}% (from v${entry.version - 1})`);
    }
    if (entry.journalSnippets && entry.journalSnippets.length > 0) {
      const formatted = entry.journalSnippets
        .map((s) => `"${s}${s.length >= 100 ? "..." : ""}"`)
        .join(",\n             ");
      lines.push(`    ${DIM}journal:${RESET} ${formatted}`);
    }
    if (entry.commit) {
      lines.push(`    ${DIM}commit:${RESET} ${entry.commit.id} — ${entry.commit.message}`);
    }
    // Content preview
    const preview = entry.content.slice(0, 120).trim().replace(/\n/g, " ");
    lines.push(`    ${preview}${entry.content.length > 120 ? "..." : ""}`);
    lines.push("");
  }

  return lines.join("\n");
}

export function formatStatusCli(result: StatusResult): string {
  return renderStatusRoute(result, { route: "cli", format: "plain" });
}

export function formatRegisterCli(
  codePath: string,
  lorePath: string,
  mcp?: EnsureProjectMcpConfigResult,
): string {
  const lines = [
    `${GREEN}✓${RESET} Initialized at ${CYAN}${codePath}${RESET}`,
    `${DIM}lore:${RESET} ${lorePath}`,
  ];

  if (mcp) {
    const canonicalNote =
      mcp.canonical.status === "created"
        ? "created"
        : mcp.canonical.status === "updated"
          ? "updated"
          : "already present";
    lines.push(
      `${DIM}mcp source:${RESET} ${mcp.canonical.path} (${canonicalNote}, server '${mcp.canonical.server}')`,
    );
    for (const harness of mcp.harnesses) {
      lines.push(formatHarnessMcpLine(harness));
    }
  }

  return lines.join("\n");
}

function formatHarnessMcpLine(harness: HarnessMcpConfigResult): string {
  const note =
    harness.status === "created"
      ? "created"
      : harness.status === "updated"
        ? "updated"
        : "already present";
  return `${DIM}${harness.harness}:${RESET} ${harness.path} (${note}, server '${harness.server}')`;
}

export function formatMcpInstallCli(
  codePath: string,
  result: EnsureProjectMcpConfigResult,
): string {
  const canonicalNote =
    result.canonical.status === "created"
      ? "created"
      : result.canonical.status === "updated"
        ? "updated"
        : "already present";
  const lines = [
    `${GREEN}✓${RESET} MCP config for ${CYAN}${codePath}${RESET}`,
    `${DIM}mcp source:${RESET} ${result.canonical.path} (${canonicalNote}, server '${result.canonical.server}')`,
    ...result.harnesses.map(formatHarnessMcpLine),
  ];
  return lines.join("\n");
}

export function formatLogCli(note?: string): string {
  let text = `${GREEN}✓${RESET} Entry saved.`;
  if (note) text += ` ${DIM}${note}${RESET}`;
  return text;
}

export function formatRebuildCli(result: {
  stateChunkCount: number;
  journalChunkCount: number;
  conceptCount: number;
  narrativeCount: number;
  embeddingCount: number;
  staleEmbeddingCount: number;
}): string {
  let text = `Rebuilt: ${compactCount(result.conceptCount)} concepts, ${compactCount(result.narrativeCount)} narratives, ${compactCount(result.stateChunkCount)} state chunks, ${compactCount(result.journalChunkCount)} journal chunks, ${compactCount(result.embeddingCount)} embeddings`;
  if (result.staleEmbeddingCount > 0) {
    text += ` ${YELLOW}(${compactCount(result.staleEmbeddingCount)} stale — run lore mind embeddings refresh)${RESET}`;
  }
  return text;
}

export function formatError(message: string): string {
  return `${RED}error:${RESET} ${message}`;
}

export function formatLifecycleResultCli(result: {
  action: string;
  commit_id: string | null;
  summary: string;
  affected: string[];
  preview?: boolean;
  proposal?: {
    source?: string;
    target?: string;
    merged_content?: string;
    splits?: Array<{ name: string; content: string }>;
  };
}): string {
  const lines: string[] = [];
  lines.push(result.summary);
  if (result.preview) {
    lines.push(`${DIM}Preview only — no changes applied.${RESET}`);
  } else if (result.commit_id) {
    lines.push(`${DIM}commit: ${result.commit_id}${RESET}`);
  }
  if (result.affected.length > 0) {
    lines.push(`${DIM}affected:${RESET} ${result.affected.join(", ")}`);
  }
  if (result.proposal?.merged_content) {
    lines.push("");
    lines.push(
      result.proposal.merged_content.slice(0, 400) +
        (result.proposal.merged_content.length > 400 ? "..." : ""),
    );
  }
  if (result.proposal?.splits && result.proposal.splits.length > 0) {
    lines.push("");
    lines.push(`${BOLD}Proposed splits:${RESET}`);
    for (const split of result.proposal.splits) {
      lines.push(`- ${split.name}`);
      lines.push(
        `  ${DIM}${split.content.slice(0, 160)}${split.content.length > 160 ? "..." : ""}${RESET}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatConceptRelationsCli(relations: ConceptRelationSummary[]): string {
  if (relations.length === 0) {
    return `${DIM}No concept relations configured.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Concept Relations${RESET}`);
  for (const relation of relations) {
    const state = relation.active ? `${GREEN}active${RESET}` : `${DIM}inactive${RESET}`;
    lines.push(
      `- ${CYAN}${relation.from_concept}${RESET} ${DIM}-${relation.relation_type}->${RESET} ${CYAN}${relation.to_concept}${RESET} ${DIM}(w=${relation.weight.toFixed(2)}, ${state}, updated ${timeAgo(relation.updated_at)})${RESET}`,
    );
  }
  return lines.join("\n");
}

export function formatConceptTagsCli(tags: ConceptTagSummary[]): string {
  if (tags.length === 0) {
    return `${DIM}No concept tags configured.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Concept Tags${RESET}`);
  for (const tag of tags) {
    lines.push(`- ${CYAN}${tag.concept}${RESET}: ${tag.tag}`);
  }
  return lines.join("\n");
}

export function formatConceptBindingsCli(
  concept: string,
  bindings: ConceptBindingSummary[],
): string {
  if (bindings.length === 0) {
    return `${DIM}No bindings for ${concept}.${RESET}`;
  }

  const lines: string[] = [];
  lines.push(`${BOLD}Bindings for ${concept}${RESET} (${compactCount(bindings.length)})`);
  for (const b of bindings) {
    const conf = b.confidence < 1.0 ? ` ${DIM}(${(b.confidence * 100).toFixed(0)}%)${RESET}` : "";
    lines.push(
      `  ${CYAN}${b.symbol_kind}${RESET} ${b.symbol_name}  ${DIM}${b.file_path}:${b.line_start}${RESET}  ${DIM}[${b.binding_type}]${RESET}${conf}`,
    );
  }
  return lines.join("\n");
}

export function formatConceptHealthComputeCli(result: ConceptHealthComputeResult): string {
  const lines: string[] = [];
  lines.push(`${BOLD}Lore Mind Health Run${RESET}`);
  lines.push(`${DIM}run_id:${RESET} ${result.run_id}`);
  lines.push(`${DIM}computed_at:${RESET} ${result.computed_at}`);
  lines.push(`${DIM}scanned:${RESET} ${compactCount(result.concepts_scanned)}`);
  lines.push(`${DIM}raw debt:${RESET} ${result.debt.toFixed(3)} (${result.debt_trend})`);

  if (result.top_stale.length > 0) {
    lines.push("");
    lines.push(`${BOLD}Top Stale Concepts${RESET}`);
    for (const row of result.top_stale) {
      const critical = row.critical ? `${RED} critical${RESET}` : "";
      lines.push(
        `- ${CYAN}${row.concept}${RESET} ${(row.final_stale * 100).toFixed(0)}%${critical}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatConceptHealthExplainCli(result: ConceptHealthExplainResult): string {
  const lines: string[] = [];
  lines.push(`${BOLD}${result.concept}${RESET}`);
  lines.push(`${DIM}run_id:${RESET} ${result.run_id}`);
  lines.push(`${DIM}computed_at:${RESET} ${result.computed_at}`);
  lines.push(`${DIM}final_stale:${RESET} ${(result.signal.final_stale * 100).toFixed(0)}%`);
  lines.push(
    `${DIM}signals:${RESET} time ${(result.signal.time_stale * 100).toFixed(0)}%, refs ${(result.signal.ref_stale * 100).toFixed(0)}%, local ${(result.signal.local_graph_stale * 100).toFixed(0)}%, shock ${(result.signal.global_shock * 100).toFixed(0)}%, influence ${(result.signal.influence * 100).toFixed(0)}%`,
  );
  if (result.signal.critical) {
    lines.push(
      `${RED}critical multiplier:${RESET} ${result.signal.critical_multiplier.toFixed(2)}`,
    );
  }

  if (result.neighbors.length > 0) {
    lines.push("");
    lines.push(`${BOLD}Neighbors${RESET}`);
    for (const neighbor of result.neighbors) {
      const stale =
        neighbor.neighbor_final_stale == null
          ? "n/a"
          : `${(neighbor.neighbor_final_stale * 100).toFixed(0)}%`;
      lines.push(
        `- ${neighbor.direction} ${neighbor.relation_type} ${CYAN}${neighbor.concept}${RESET} ${DIM}(w=${neighbor.weight.toFixed(2)}, stale=${stale})${RESET}`,
      );
    }
  }

  return lines.join("\n");
}

export function formatHealConceptsCli(result: HealConceptsResult): string {
  const lines: string[] = [];
  lines.push(`${BOLD}Heal Run${RESET}`);
  lines.push(`${DIM}run_id:${RESET} ${result.run_id}`);
  lines.push(`${DIM}dry:${RESET} ${result.dry}`);
  lines.push(`${DIM}considered:${RESET} ${compactCount(result.considered)}`);
  lines.push(`${DIM}healed:${RESET} ${compactCount(result.healed.length)}`);

  if (result.healed.length > 0) {
    lines.push("");
    for (const concept of result.healed) {
      lines.push(
        `- ${CYAN}${concept.concept}${RESET}: staleness ${(concept.from_staleness * 100).toFixed(0)}% -> ${(concept.to_staleness * 100).toFixed(0)}%, residual ${(concept.from_residual * 100).toFixed(0)}% -> ${(concept.to_residual * 100).toFixed(0)}%`,
      );
    }
  }

  return lines.join("\n");
}
