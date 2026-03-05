import type { ConceptBindingSummary, ConceptRelationSummary, LoreConfig, QueryResult, RecallResult } from "@lore/worker";
import { formatBindings, renderExecutiveSummary, timeAgo } from "@lore/worker";

export {
  formatOpen,
  formatLog,
  formatQuery,
  formatClose,
  formatCommitLog,
  formatNarrativeTrail,
  formatDryRunClose,
  formatStatus,
  formatLs,
  formatShow,
  formatHistory,
  formatLifecycleResult,
  formatSuggest,
  formatTreeDiff,
  formatBootstrapPlan,
} from "@lore/worker";

export function formatRelationsMcp(relations: ConceptRelationSummary[], concept: string): string {
  if (relations.length === 0) return "";

  const outbound = relations.filter((r) => r.from_concept === concept);
  const inbound = relations.filter((r) => r.to_concept === concept);

  const lines: string[] = ["## Relations"];

  if (outbound.length > 0) {
    lines.push("**Outbound**");
    for (const r of outbound) {
      const weightStr = r.weight !== 1.0 ? ` (weight: ${r.weight})` : "";
      lines.push(`→ ${r.to_concept} — ${r.relation_type}${weightStr}`);
    }
  }

  if (inbound.length > 0) {
    lines.push("**Inbound**");
    for (const r of inbound) {
      lines.push(`← ${r.from_concept} — ${r.relation_type}`);
    }
  }

  return lines.join("\n");
}

export function formatBindingsMcp(bindings: ConceptBindingSummary[]): string {
  return formatBindings(bindings);
}

function formatJournalTrail(groups: NonNullable<QueryResult["journal_results"]>): string[] {
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
          ? entry.content.slice(0, 200).trim() + "..."
          : entry.content.trim();
      lines.push(`  ${i + 1}. ${statusTag}${posTag}"${preview}"`);
    }
    if (group.other_topics.length > 0) {
      lines.push(`  Also covers: ${group.other_topics.join(", ")}`);
    }
  }
  return lines;
}

export function formatAskMcp(
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

  // Render per-claim attribution if available
  let claimBlock = "";
  if (es?.claims && es.claims.length > 0) {
    const claimLines = es.claims.map((c) => {
      const pct = `${(c.confidence * 100).toFixed(0)}%`;
      const warn = c.confidence < 0.5 ? " ⚠ low confidence" : "";
      const staleTag = c.max_staleness != null && c.max_staleness > 0.4
        ? ` — stale (${(c.max_staleness * 100).toFixed(0)}%)`
        : "";
      return `[${pct}] ${c.text} [${c.source_concepts.join(", ")}]${warn}${staleTag}`;
    });
    claimBlock = "\n\n## Attribution\n" + claimLines.join("\n");
  }

  // Binding nudge: agent used source chunks for grounding but they have no concept bindings.
  // High-accuracy grounding used this time, but a concept binding would make future retrieval robust.
  const unboundSymbols = es?.unbound_source_symbols;
  const bindingNudge =
    unboundSymbols && unboundSymbols.length > 0
      ? `\n⚠ Used authoritative source-chunk grounding for: ${unboundSymbols.join(", ")}. ` +
        `These symbols have no concept bindings — future retrieval will rely on embedding similarity. ` +
        `Bind them now for robust grounding: \`lore bind <concept> <symbol>\``
      : "";

  if (!opts?.includeSources) {
    const parts = [headline];
    if (claimBlock) parts.push(claimBlock);
    if (bindingNudge) parts.push(bindingNudge);
    if (result.journal_results && result.journal_results.length > 0) {
      parts.push(...formatJournalTrail(result.journal_results));
    }
    return parts.join("\n").trimEnd();
  }

  const lines: string[] = [headline];
  if (claimBlock) lines.push(claimBlock);
  if (bindingNudge) lines.push(bindingNudge);
  lines.push("", "## Sources");
  if (result.results.length === 0 && (!result.web_results || result.web_results.length === 0)) {
    lines.push("No sources available.");
    if (result.journal_results && result.journal_results.length > 0) {
      lines.push(...formatJournalTrail(result.journal_results));
    }
    return lines.join("\n").trimEnd();
  }

  for (const item of result.results) {
    const files = item.meta.files.length > 0 ? item.meta.files.join(", ") : "no file refs";
    lines.push(`- ${item.concept} (score ${(item.meta.score * 100).toFixed(1)}%)`);
    lines.push(`  updated: ${item.meta.last_updated ? timeAgo(item.meta.last_updated) : "unknown"}`);
    if (item.meta.last_narrative) {
      const narrativeAge = item.meta.last_narrative.closed_at ? timeAgo(item.meta.last_narrative.closed_at) : "";
      lines.push(`  last narrative: ${item.meta.last_narrative.name} (${narrativeAge}) — "${item.meta.last_narrative.intent}"`);
    }
    lines.push(`  files: ${files}`);
    lines.push(`  chunk: ${item.meta.chunk_id}`);
    if (item.meta.cluster != null) {
      lines.push(`  cluster: ${item.meta.cluster}`);
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
      const hop2Parts = item.meta.neighbors_2hop.map((n) => `${n.concept} (${n.path})`);
      lines.push(`  2-hop neighbors: ${hop2Parts.join(", ")}`);
    }
    if (item.meta.bindings && item.meta.bindings.length > 0) {
      const top = item.meta.bindings.slice(0, 10);
      const bindParts = top.map((b) => `${b.symbol} (${b.kind}, ${b.file}:${b.line})`);
      const suffix =
        item.meta.bindings.length > 10 ? ` (+${item.meta.bindings.length - 10} more)` : "";
      lines.push(`  bindings: ${bindParts.join(", ")}${suffix}`);
    }
    if (item.warning) {
      lines.push(`  warning: ${item.warning}`);
    }
  }

  if (result.web_results && result.web_results.length > 0) {
    lines.push("");
    lines.push("## Web Sources");
    for (const item of result.web_results) {
      lines.push(`- ${item.title} (${item.source})`);
      lines.push(`  ${item.url}`);
    }
  }

  if (result.journal_results && result.journal_results.length > 0) {
    lines.push(...formatJournalTrail(result.journal_results));
  }

  return lines.join("\n").trimEnd();
}

export function formatAskMcpBrief(result: QueryResult): string {
  const es = result.executive_summary;
  const summaryFallback = result.results[0]?.summary?.trim();
  const headline = es
    ? renderExecutiveSummary(es, { exactness: result.meta.grounding.exactness_detected })
    : summaryFallback && summaryFallback.length > 0
      ? summaryFallback
      : "No matching concepts.";

  const parts: string[] = [headline];

  // Render per-claim attribution if available
  if (es?.claims && es.claims.length > 0) {
    const claimLines = es.claims.map((c) => {
      const pct = `${(c.confidence * 100).toFixed(0)}%`;
      const warn = c.confidence < 0.5 ? " ⚠ low confidence" : "";
      const staleTag = c.max_staleness != null && c.max_staleness > 0.4
        ? ` — stale (${(c.max_staleness * 100).toFixed(0)}%)`
        : "";
      return `[${pct}] ${c.text} [${c.source_concepts.join(", ")}]${warn}${staleTag}`;
    });
    parts.push("\n\n## Attribution\n" + claimLines.join("\n"));
  }

  // Binding nudge: source chunks used but symbols not bound to concepts
  const unboundSymbols = es?.unbound_source_symbols;
  if (unboundSymbols && unboundSymbols.length > 0) {
    parts.push(
      `\n⚠ Used authoritative source-chunk grounding for: ${unboundSymbols.join(", ")}. ` +
        `These symbols have no concept bindings — future retrieval will rely on embedding similarity. ` +
        `Bind them now for robust grounding: \`lore bind <concept> <symbol>\``,
    );
  }

  // Provenance line
  const counts = es?.counts ?? { concepts: result.results.length, files: 0, symbols: 0, journal_entries: 0 };
  const fileCount = counts.files || result.results.reduce((sum, r) => sum + r.meta.files.length, 0);
  parts.push(
    `\nBased on ${counts.concepts} concept${counts.concepts !== 1 ? "s" : ""}, ${fileCount} file${fileCount !== 1 ? "s" : ""}, ${counts.symbols} symbol${counts.symbols !== 1 ? "s" : ""}, ${counts.journal_entries} journal entr${counts.journal_entries !== 1 ? "ies" : "y"}.`,
  );

  // Footer with result_id and timing
  if (result.result_id) {
    const timing = result.meta.generated_in ? ` · ${result.meta.generated_in}` : "";
    parts.push(
      `\nResult ID: ${result.result_id}${timing} — use recall(result_id) for full sources, or score(result_id, 1-5) to rate this answer.`,
    );
  }

  return parts.join("\n").trimEnd();
}

export type RecallSection = "sources" | "journal" | "symbols" | "full";

export function formatRecallMcp(
  recalled: RecallResult,
  section: RecallSection = "full",
): string {
  const result = recalled.result;
  const scoreStr = recalled.score != null ? `scored: ${recalled.score}/5` : "unscored";
  const age = timeAgo(recalled.created_at);
  const lines: string[] = [
    `Recalled: "${recalled.query_text}" (${scoreStr}, ${age})`,
  ];

  const showSources = section === "sources" || section === "full";
  const showJournal = section === "journal" || section === "full";
  const showSymbols = section === "symbols" || section === "full";

  if (showSources && result.results.length > 0) {
    lines.push("", "## Sources");
    for (const item of result.results) {
      const files = item.meta.files.length > 0 ? item.meta.files.join(", ") : "no file refs";
      lines.push(`- ${item.concept} (score ${(item.meta.score * 100).toFixed(1)}%)`);
      lines.push(`  updated: ${item.meta.last_updated ? timeAgo(item.meta.last_updated) : "unknown"}`);
      if (item.meta.last_narrative) {
        const narrativeAge = item.meta.last_narrative.closed_at ? timeAgo(item.meta.last_narrative.closed_at) : "";
        lines.push(`  last narrative: ${item.meta.last_narrative.name} (${narrativeAge}) — "${item.meta.last_narrative.intent}"`);
      }
      lines.push(`  files: ${files}`);
      lines.push(`  chunk: ${item.meta.chunk_id}`);
      if (item.meta.cluster != null) {
        lines.push(`  cluster: ${item.meta.cluster}`);
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
        const hop2Parts = item.meta.neighbors_2hop.map((n) => `${n.concept} (${n.path})`);
        lines.push(`  2-hop neighbors: ${hop2Parts.join(", ")}`);
      }
      if (item.meta.bindings && item.meta.bindings.length > 0) {
        const top = item.meta.bindings.slice(0, 10);
        const bindParts = top.map((b) => `${b.symbol} (${b.kind}, ${b.file}:${b.line})`);
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
  }

  if (showJournal && result.journal_results && result.journal_results.length > 0) {
    lines.push(...formatJournalTrail(result.journal_results));
  }

  if (showSymbols && result.symbol_results && result.symbol_results.length > 0) {
    lines.push("", "## Symbols");
    for (const sym of result.symbol_results) {
      const boundTag = sym.bound_concepts?.length
        ? ` → [${sym.bound_concepts.join(", ")}]`
        : "";
      lines.push(`- ${sym.kind} ${sym.qualified_name} (${sym.file_path}:${sym.line_start})${boundTag}`);
    }
  }

  return lines.join("\n").trimEnd();
}

// ─── Config formatters ─────────────────────────────────────────────────────

function deepGet(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc != null && typeof acc === "object") return (acc as Record<string, unknown>)[key];
    return undefined;
  }, obj);
}

function loreTag(overrides: Partial<LoreConfig> | undefined, path: string): string {
  return overrides !== undefined && deepGet(overrides, path) !== undefined ? " (lore)" : "";
}

export function formatConfigCurated(
  resolved: LoreConfig,
  overrides: Partial<LoreConfig> | undefined,
): string {
  const h = (path: string) => loreTag(overrides, path);
  const lines: string[] = [];

  lines.push("Generation");
  lines.push(`  provider: ${resolved.ai.generation.provider}${h("ai.generation.provider")}`);
  lines.push(`  model:    ${resolved.ai.generation.model}${h("ai.generation.model")}`);
  if (resolved.ai.generation.base_url)
    lines.push(`  base_url: ${resolved.ai.generation.base_url}${h("ai.generation.base_url")}`);
  lines.push(
    `  api_key:  ${resolved.ai.generation.api_key ? "(set)" : "(not set)"}${h("ai.generation.api_key")}`,
  );
  if (resolved.ai.generation.reasoning)
    lines.push(`  reasoning: ${resolved.ai.generation.reasoning}${h("ai.generation.reasoning")}`);

  lines.push("");
  lines.push("Embedding");
  lines.push(`  provider: ${resolved.ai.embedding.provider}${h("ai.embedding.provider")}`);
  lines.push(`  model:    ${resolved.ai.embedding.model}${h("ai.embedding.model")}`);
  lines.push(`  dim:      ${resolved.ai.embedding.dim}${h("ai.embedding.dim")}`);
  if (resolved.ai.embedding.base_url)
    lines.push(`  base_url: ${resolved.ai.embedding.base_url}${h("ai.embedding.base_url")}`);

  const rerank = resolved.ai.search?.rerank;
  lines.push("");
  lines.push("Reranker");
  lines.push(`  enabled: ${rerank?.enabled ?? false}${h("ai.search.rerank.enabled")}`);
  if (rerank?.enabled)
    lines.push(`  model:   ${rerank.model ?? "rerank-v3.5"}${h("ai.search.rerank.model")}`);

  const es = resolved.ai.search?.executive_summary;
  const esTimeout = resolved.ai.search?.timeouts?.executive_summary_ms ?? 30000;
  lines.push("");
  lines.push("Executive Summary");
  lines.push(`  enabled: ${es?.enabled ?? true}${h("ai.search.executive_summary.enabled")}`);
  if (es?.model) lines.push(`  model:   ${es.model}${h("ai.search.executive_summary.model")}`);
  lines.push(`  timeout: ${esTimeout}ms${h("ai.search.timeouts.executive_summary_ms")}`);

  lines.push("");
  lines.push("Thresholds");
  lines.push(`  staleness_days: ${resolved.thresholds.staleness_days}${h("thresholds.staleness_days")}`);
  lines.push(`  dangling_days:  ${resolved.thresholds.dangling_days}${h("thresholds.dangling_days")}`);
  lines.push(
    `  max_log_n:      ${resolved.thresholds.max_log_n}  →  ${Math.pow(2, resolved.thresholds.max_log_n)} chars max${h("thresholds.max_log_n")}`,
  );
  lines.push(`  rrf.k:          ${resolved.rrf.k}${h("rrf.k")}`);

  if (overrides && Object.keys(overrides).length > 0) {
    lines.push("");
    lines.push("(lore) = per-lore override active");
  }

  return lines.join("\n");
}

export function formatConfigGet(
  key: string,
  resolved: LoreConfig,
  overrides: Partial<LoreConfig> | undefined,
): string {
  const resolvedValue = deepGet(resolved, key);
  const overrideValue = overrides !== undefined ? deepGet(overrides, key) : undefined;
  const source = overrideValue !== undefined ? "(lore override)" : "(default / global)";
  if (resolvedValue === undefined) return `${key}: (not found)`;
  const display =
    key.toLowerCase().includes("api_key") && typeof resolvedValue === "string" && resolvedValue
      ? "(set)"
      : JSON.stringify(resolvedValue);
  return `${key} = ${display}\nsource: ${source}`;
}

export function formatConfigSet(key: string, value: unknown): string {
  return `Set ${key} = ${JSON.stringify(value)}`;
}
