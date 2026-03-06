import type {
  OpenResult,
  LogResult,
  QueryResult,
  CloseResult,
  StatusResult,
  ConceptRow,
  ConceptBindingSummary,
  CommitLogEntry,
  NarrativeRow,
  NarrativeTrailResult,
  RegistryEntry,
  SuggestResult,
  Suggestion,
  SuggestionStep,
  TreeDiff,
  BootstrapPlan,
} from "@/types/index.ts";
import { computeLineDiff, isDiffTooLarge } from "@/engine/line-diff.ts";

export interface DryRunCloseFormatInput {
  narrative: NarrativeRow;
  plan: {
    updates: Array<{ conceptName: string; newContent: string; strategy?: "patch" | "rewrite" }>;
    creates: Array<{ conceptName: string; content: string }>;
  };
  unresolved_entries?: Array<{ chunk_id: string; created_at: string; reason: string }>;
}
import { timeAgo } from "@/format.ts";

export function formatOpen(result: OpenResult): string {
  const lines: string[] = [];
  if (result.context.read_now.length > 0) {
    lines.push("## Relevant Context\n");
    for (const item of result.context.read_now) {
      const warn = item.warning ? ` ⚠ ${item.warning}` : "";
      lines.push(`- **${item.file}** (${item.priority})${warn}`);
      lines.push(`  ${item.summary}`);
    }
  }
  if (result.context.heads_up.length > 0) {
    lines.push("\n## Heads Up\n");
    for (const note of result.context.heads_up) {
      lines.push(`- ${note}`);
    }
  }
  return lines.join("\n");
}

export function formatLog(result: LogResult): string {
  let text = result.saved ? "Entry saved." : "Failed to save entry.";
  if (result.note) text += ` ${result.note}`;
  return text;
}

function formatPct(value: number | null): string {
  return value == null ? "n/a" : `${(value * 100).toFixed(0)}%`;
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
  if (sev.level === "none") return " ✓ fresh";
  const ratio = `${(sev.ratio * 100).toFixed(0)}%`;
  if (sev.level === "low") return ` ~ ${compactCount(stale)} stale (${ratio})`;
  if (sev.level === "medium") return ` ⚠ ${compactCount(stale)} stale (${ratio})`;
  return ` ⚠ HIGH ${compactCount(stale)} stale (${ratio})`;
}

export function formatQuery(result: QueryResult): string {
  const lines: string[] = [];
  lines.push("## Query Metadata");
  lines.push("");
  lines.push("```yaml");
  lines.push(`query: ${JSON.stringify(result.meta.query)}`);
  lines.push(`generated_at: ${result.meta.generated_at}`);
  lines.push(`generated_in: ${result.meta.generated_in}`);
  lines.push(`brief: ${result.meta.brief}`);
  lines.push("scanned:");
  lines.push(`  local_candidates: ${compactCount(result.meta.scanned.local_candidates)}`);
  lines.push(`  returned_results: ${compactCount(result.meta.scanned.returned_results)}`);
  lines.push(`  return_limit: ${compactCount(result.meta.scanned.return_limit)}`);
  lines.push(`  vector_limit: ${compactCount(result.meta.scanned.vector_limit)}`);
  lines.push(
    `  text_vector_candidates: ${compactCount(result.meta.scanned.text_vector_candidates)}`,
  );
  lines.push(
    `  code_vector_candidates: ${compactCount(result.meta.scanned.code_vector_candidates)}`,
  );
  lines.push(`  fused_candidates: ${compactCount(result.meta.scanned.fused_candidates)}`);
  lines.push(`  staleness_checks: ${compactCount(result.meta.scanned.staleness_checks)}`);
  lines.push("  web:");
  lines.push(`    enabled: ${result.meta.scanned.web_search_enabled}`);
  lines.push(`    results: ${compactCount(result.meta.scanned.web_results)}`);
  lines.push("  journal:");
  lines.push(`    candidates: ${compactCount(result.meta.scanned.journal_candidates ?? 0)}`);
  lines.push(`    results: ${compactCount(result.meta.scanned.journal_results ?? 0)}`);
  lines.push("rerank:");
  lines.push(`  enabled: ${result.meta.rerank.enabled}`);
  lines.push(`  attempted: ${result.meta.rerank.attempted}`);
  lines.push(`  applied: ${result.meta.rerank.applied}`);
  lines.push(`  model: ${result.meta.rerank.model}`);
  lines.push(`  candidates: ${compactCount(result.meta.rerank.candidates)}`);
  lines.push(`  reason: ${JSON.stringify(result.meta.rerank.reason)}`);
  lines.push("executive_summary:");
  lines.push(`  enabled: ${result.meta.executive_summary.enabled}`);
  lines.push(`  attempted: ${result.meta.executive_summary.attempted}`);
  lines.push(`  generated: ${result.meta.executive_summary.generated}`);
  lines.push(`  model: ${result.meta.executive_summary.model}`);
  if (result.meta.executive_summary.model_id) {
    lines.push(`  model_id: ${result.meta.executive_summary.model_id}`);
  }
  lines.push(`  reason: ${JSON.stringify(result.meta.executive_summary.reason)}`);
  lines.push(`  source_matches: ${compactCount(result.meta.executive_summary.source_matches)}`);
  if (result.meta.executive_summary.usage?.total_tokens > 0) {
    const u = result.meta.executive_summary.usage;
    lines.push(
      `  tokens: ${compactCount(u.prompt_tokens)} in / ${compactCount(u.completion_tokens)} out (${compactCount(u.total_tokens)} total)`,
    );
  }
  lines.push("grounding:");
  lines.push(`  enabled: ${result.meta.grounding.enabled}`);
  lines.push(`  attempted: ${result.meta.grounding.attempted}`);
  lines.push(`  exactness_detected: ${result.meta.grounding.exactness_detected}`);
  lines.push(`  hits_total: ${compactCount(result.meta.grounding.hits_total)}`);
  lines.push(`  files_considered: ${compactCount(result.meta.grounding.files_considered)}`);
  lines.push(`  mode: ${result.meta.grounding.mode}`);
  lines.push(`  reason: ${JSON.stringify(result.meta.grounding.reason)}`);
  lines.push("structural_boost:");
  lines.push(`  enabled: ${result.meta.structural_boost.enabled}`);
  lines.push(`  symbols_matched: ${compactCount(result.meta.structural_boost.symbols_matched)}`);
  lines.push(`  concepts_boosted: ${compactCount(result.meta.structural_boost.concepts_boosted)}`);
  if (result.meta.ask_debt) {
    lines.push("ask_debt:");
    lines.push(`  score: ${result.meta.ask_debt.score.toFixed(1)}`);
    lines.push(`  confidence: ${result.meta.ask_debt.confidence.toFixed(1)}`);
    lines.push(`  band: ${result.meta.ask_debt.band}`);
    lines.push(`  retrieval_multiplier: ${result.meta.ask_debt.retrieval_multiplier.toFixed(2)}`);
    lines.push(
      `  staleness_penalty_multiplier: ${result.meta.ask_debt.staleness_penalty_multiplier.toFixed(2)}`,
    );
  }
  lines.push("```");
  lines.push("");

  if (result.executive_summary) {
    lines.push("## Executive Summary");
    lines.push("");
    const es = result.executive_summary;
    if (es.kind === "uncertain" && es.uncertainty_reason) {
      lines.push(`Uncertain: ${es.uncertainty_reason}`);
    } else if (es.narrative) {
      lines.push(es.narrative);
    }
    lines.push("");
  }

  if (result.results.length === 0) {
    lines.push("No matching concepts.");
    lines.push("");
  }

  for (let index = 0; index < result.results.length; index++) {
    const item = result.results[index]!;
    const files = item.meta.files.length > 0 ? item.meta.files.join(", ") : "(none)";
    lines.push(`## Result ${index + 1}: ${item.concept}`);
    lines.push(`- score: ${(item.meta.score * 100).toFixed(1)}%`);
    lines.push(`- chunk_id: ${item.meta.chunk_id}`);
    lines.push(`- residual: ${formatPct(item.meta.residual)}`);
    lines.push(`- staleness: ${formatPct(item.meta.staleness)}`);
    lines.push(
      `- last_updated: ${item.meta.last_updated ? timeAgo(item.meta.last_updated) : "unknown"}`,
    );
    if (item.meta.last_narrative) {
      const narrativeAge = item.meta.last_narrative.closed_at
        ? timeAgo(item.meta.last_narrative.closed_at)
        : "";
      lines.push(
        `- last narrative: ${item.meta.last_narrative.name} (${narrativeAge}) — "${item.meta.last_narrative.intent}"`,
      );
    }
    lines.push(`- symbol_drift: ${item.meta.symbol_drift}`);
    lines.push(
      `- symbols: bound=${compactCount(item.meta.symbols_bound)}, drifted=${compactCount(item.meta.symbols_drifted)}`,
    );
    lines.push(`- files: ${files}`);
    if (item.meta.cluster != null) {
      lines.push(`- cluster: ${item.meta.cluster}`);
    }
    if (item.meta.cluster_summary) {
      lines.push(`- cluster summary: ${item.meta.cluster_summary}`);
    }
    if (item.meta.cluster_peers && item.meta.cluster_peers.length > 0) {
      lines.push(`- cluster peers: ${item.meta.cluster_peers.join(", ")}`);
    }
    if (item.meta.relations && item.meta.relations.length > 0) {
      const relParts = item.meta.relations.map((rel) => {
        const arrow = rel.direction === "outbound" ? "→" : "←";
        return `${arrow} ${rel.concept} (${rel.type}, ${rel.weight})`;
      });
      lines.push(`- relations: ${relParts.join(", ")}`);
    }
    if (item.meta.neighbors_2hop && item.meta.neighbors_2hop.length > 0) {
      const hop2Parts = item.meta.neighbors_2hop.map((n) => {
        const w = n.weight != null ? ` ${(n.weight * 100).toFixed(0)}%` : "";
        return `${n.path}${w}`;
      });
      lines.push(`- 2-hop neighbors: ${hop2Parts.join(", ")}`);
    }
    if (item.meta.bindings && item.meta.bindings.length > 0) {
      const bindParts = item.meta.bindings.map(
        (b) => `${b.symbol} (${b.kind}, ${b.file}:${b.line})`,
      );
      lines.push(`- bindings: ${bindParts.join(", ")}`);
    }
    if (item.warning) {
      lines.push(`- warning: ${item.warning}`);
    }
    lines.push("");
    if (item.excerpts && item.excerpts.length > 0) {
      lines.push(item.excerpts.join("\n\n...\n\n"));
    } else {
      lines.push(item.content);
    }
    lines.push("");
  }
  if (result.web_results && result.web_results.length > 0) {
    lines.push("## Web Results");
    lines.push("");
    for (const item of result.web_results) {
      lines.push(`- **${item.title}** (${item.source})`);
      lines.push(`  ${item.snippet}`);
      lines.push(`  ${item.url}`);
    }
  }
  if (result.journal_results && result.journal_results.length > 0) {
    lines.push("");
    lines.push("## Investigation Trail");
    lines.push("");
    for (const group of result.journal_results) {
      const age = timeAgo(group.opened_at);
      const matched = group.matched_entries.length;
      const entryWord = group.total_entries === 1 ? "entry" : "entries";
      const matchWord = matched === 1 ? "matched" : "matched";
      lines.push(`### ${group.narrative_name} (${age}) — ${group.narrative_intent}`);
      lines.push(
        `*${group.narrative_status} · ${compactCount(group.total_entries)} ${entryWord} (${compactCount(matched)} ${matchWord})*`,
      );
      lines.push("");
      for (const entry of group.matched_entries) {
        const statusTag = entry.status ? `[${entry.status}] ` : "";
        const posTag =
          entry.entry_index > 0 ? `(${entry.entry_index}/${group.total_entries}) ` : "";
        lines.push(`- ${statusTag}${posTag}${entry.content}`);
        if (entry.topics.length > 0) {
          lines.push(`  Topics: ${entry.topics.join(", ")}`);
        }
      }
      if (group.other_topics.length > 0) {
        lines.push("");
        lines.push(`*Also covers: ${group.other_topics.join(", ")}*`);
      }
      lines.push("");
    }
  }
  return lines.join("\n");
}

export function formatClose(result: CloseResult): string {
  const lines: string[] = [];

  if (result.mode === "discard") {
    lines.push(result.impact.summary);
    return lines.join("\n");
  }

  if (!result.integrated && result.close_job) {
    lines.push(`Close queued. Job: ${result.close_job.id}`);
    lines.push(`Narrative: ${result.close_job.narrative_name}`);
    lines.push(`Status: ${result.close_job.status}`);
    lines.push(result.impact.summary);
    if (result.follow_up) lines.push(`Follow-up: ${result.follow_up}`);
    return lines.join("\n");
  }

  lines.push(`Integration complete. Commit: ${result.commit_id}`);
  if (result.concepts_updated.length > 0) {
    lines.push(`Updated: ${result.concepts_updated.join(", ")}`);
  }
  if (result.concepts_created.length > 0) {
    lines.push(`Created: ${result.concepts_created.join(", ")}`);
  }
  if (result.conflicts.length > 0) {
    lines.push(`\n**Merge conflicts (auto-resolved):** ${result.conflicts.length}`);
    for (const c of result.conflicts) {
      lines.push(`- ${c.conceptName}: ${c.resolution}`);
    }
  }
  if (result.impact.debt_before != null && result.impact.debt_after != null) {
    lines.push(
      `Debt: ${result.impact.debt_before.toFixed(1)} → ${result.impact.debt_after.toFixed(1)}`,
    );
  } else {
    lines.push("Debt: refresh queued");
  }
  lines.push(result.impact.summary);
  if (result.impact.concept_impacts && result.impact.concept_impacts.length > 0) {
    lines.push("\nPer-concept impact:");
    for (const ci of result.impact.concept_impacts) {
      const before =
        ci.residual_before != null ? `${(ci.residual_before * 100).toFixed(0)}%` : "new";
      const after = ci.residual_after != null ? `${(ci.residual_after * 100).toFixed(0)}%` : "?";
      if (ci.residual_before == null) {
        const diffTag = ci.content_diff ? ` [+${ci.content_diff.adds} lines]` : "";
        lines.push(`  ${ci.concept}: new (${after})${diffTag}`);
      } else {
        const delta = ((ci.residual_after ?? 0) - ci.residual_before) * 100;
        const sign = delta <= 0 ? "" : "+";
        const diffTag = ci.content_diff
          ? ` [+${ci.content_diff.adds}/-${ci.content_diff.removes} lines]`
          : "";
        lines.push(`  ${ci.concept}: ${before} → ${after} (${sign}${delta.toFixed(0)}%)${diffTag}`);
      }
    }
  }
  if (result.coverage_change) {
    const b = result.coverage_change.before;
    const a = result.coverage_change.after;
    const bPct = (b.ratio * 100).toFixed(0);
    const aPct = (a.ratio * 100).toFixed(0);
    const symbolsDelta = a.exported_covered - b.exported_covered;
    const sign = symbolsDelta >= 0 ? "+" : "";
    lines.push(`Coverage: ${bPct}% → ${aPct}% (${sign}${symbolsDelta} symbols covered)`);
  }
  if (result.concept_overlaps && result.concept_overlaps.length > 0) {
    lines.push("\n⚠ Concept overlap detected:");
    for (const o of result.concept_overlaps) {
      const pct = (o.similarity * 100).toFixed(0);
      lines.push(`  • '${o.concept}' ↔ '${o.overlaps_with}' (${pct}% similar)`);
      lines.push(
        `    Did you mean to also update '${o.overlaps_with}'? Open a new narrative targeting it.`,
      );
    }
  }
  if (result.phase_transitions && result.phase_transitions.length > 0) {
    lines.push("\n## Phase Transitions\n");
    for (const pt of result.phase_transitions) {
      const distPct = (pt.distance * 100).toFixed(0);
      const tag =
        pt.magnitude === "structural"
          ? "[STRUCTURAL]"
          : pt.magnitude === "strong"
            ? "[STRONG]"
            : "[moderate]";
      lines.push(`${tag} ${pt.concept_name} — distance ${distPct}%`);
      if (pt.magnitude === "structural") {
        lines.push(`  ! Likely contradiction or architectural shift. Review concept after close.`);
      } else if (pt.magnitude === "strong") {
        lines.push(`  Possible restructure. Recommend reviewing '${pt.concept_name}' content.`);
      }
    }
  }
  if (result.maintenance) {
    lines.push(
      `Maintenance: ${result.maintenance.status} (${result.maintenance.pending_jobs} pending, ${result.maintenance.failed_jobs} failed)`,
    );
  }
  if (result.follow_up) lines.push(`\nFollow-up: ${result.follow_up}`);
  return lines.join("\n");
}

export function formatDryRunClose(result: DryRunCloseFormatInput): string {
  const lines: string[] = [];
  lines.push(`## Close Preview: ${result.narrative.name}\n`);

  if (result.unresolved_entries && result.unresolved_entries.length > 0) {
    lines.push("### Unresolved Entries");
    for (const entry of result.unresolved_entries) {
      lines.push(`- ${entry.chunk_id}: ${entry.reason}`);
    }
    lines.push("");
  }

  if (result.plan.updates.length > 0) {
    lines.push(`### Updates (${result.plan.updates.length})`);
    for (const u of result.plan.updates) {
      const preview = u.newContent.slice(0, 200).trim();
      const strategy = u.strategy ? ` (${u.strategy})` : "";
      lines.push(
        `- **${u.conceptName}**${strategy} — ${preview}${u.newContent.length > 200 ? "..." : ""}`,
      );
    }
    lines.push("");
  }

  if (result.plan.creates.length > 0) {
    lines.push(`### Creates (${result.plan.creates.length})`);
    for (const c of result.plan.creates) {
      const preview = c.content.slice(0, 200).trim();
      lines.push(`- **${c.conceptName}** — ${preview}${c.content.length > 200 ? "..." : ""}`);
    }
    lines.push("");
  }

  if (
    result.plan.updates.length === 0 &&
    result.plan.creates.length === 0 &&
    (!result.unresolved_entries || result.unresolved_entries.length === 0)
  ) {
    lines.push("No changes planned.");
  }

  return lines.join("\n");
}

export function formatStatus(result: StatusResult): string {
  const lines: string[] = [];
  lines.push(`Health: ${result.health}`);
  lines.push(result.summary);
  if (result.state_distance != null) {
    lines.push(
      `State distance: ${(result.state_distance * 100).toFixed(0)}% (epistemological gap vs codebase)`,
    );
  }

  if ((result.debt ?? 0) > 0) {
    lines.push("Debt path: run suggest() and prioritize items with non-zero impact.");
  }

  if (result.lake) {
    const l = result.lake;
    const codeAge = l.last_code_indexed_at ? timeAgo(l.last_code_indexed_at) : "never";
    const docAge = l.last_doc_indexed_at ? timeAgo(l.last_doc_indexed_at) : "never";
    const codeSev = staleSeverity(l.stale_source_files, Math.max(1, l.source_files));
    const docSev = staleSeverity(l.stale_doc_files, Math.max(1, l.doc_chunks));
    const codeStale = staleLabel(l.stale_source_files, Math.max(1, l.source_files));
    const docStale = staleLabel(l.stale_doc_files, Math.max(1, l.doc_chunks));
    lines.push("\n## Lake\n");
    lines.push(
      `code:    ${compactCount(l.source_chunks)} symbols · ${compactCount(l.source_files)} files · ${codeAge}${codeStale}`,
    );
    lines.push(`docs:    ${compactCount(l.doc_chunks)} files · ${docAge}${docStale}`);
    lines.push(`journal: ${compactCount(l.journal_entries)} entries`);
    if (
      codeSev.level === "high" ||
      codeSev.level === "medium" ||
      docSev.level === "high" ||
      docSev.level === "medium"
    ) {
      lines.push(`\n⚠ Index is stale — run ingest() to refresh`);
    } else if (codeSev.level === "low" || docSev.level === "low") {
      lines.push(`\nMinor index drift — ingest() when convenient`);
    }
  }

  if (result.priorities.length > 0) {
    lines.push("\n## Priorities\n");
    for (const p of result.priorities) {
      lines.push(`- **${p.concept}**: ${p.action} — ${p.reason}`);
      if (p.last_narrative) {
        const narrativeAge = p.last_narrative.closed_at
          ? timeAgo(p.last_narrative.closed_at)
          : "unknown";
        lines.push(
          `  Last narrative: ${p.last_narrative.name} (${narrativeAge}) — "${p.last_narrative.intent}"`,
        );
      }
      if (p.changed_at) {
        lines.push(`  Last changed: ${timeAgo(p.changed_at)}`);
      }
    }
  }

  if (result.active_narratives.length > 0) {
    lines.push("\n## Active Narratives\n");
    for (const d of result.active_narratives) {
      lines.push(`- **${d.name}**: ${compactCount(d.entry_count)} entries, ${d.note}`);
    }
  }

  if (result.dangling_narratives.length > 0) {
    lines.push("\n## Dangling Narratives\n");
    for (const d of result.dangling_narratives) {
      lines.push(`- **${d.name}**: ${compactCount(d.age_days)} days old — ${d.action}`);
    }
  }

  if (result.embedding_status && result.embedding_status.stale > 0) {
    lines.push("\n## Embedding Mismatch\n");
    lines.push(
      `${compactCount(result.embedding_status.stale)}/${compactCount(result.embedding_status.total)} embeddings use an outdated model (current: **${result.embedding_status.model}**).`,
    );
    lines.push("Run `lore mind embeddings refresh` to recompute all embeddings.");
  }

  if (result.coverage) {
    const pct = (result.coverage.ratio * 100).toFixed(0);
    lines.push(`\n## Coverage & Bindings\n`);
    lines.push(
      `coverage: ${pct}% (${compactCount(result.coverage.exported_covered)}/${compactCount(result.coverage.exported_total)} exported symbols)`,
    );
    if (result.coverage.total_bindings != null) {
      lines.push(
        `bindings: ${compactCount(result.coverage.total_bindings)} (ref: ${compactCount(result.coverage.by_type.ref)}, mention: ${compactCount(result.coverage.by_type.mention)})`,
      );
      lines.push(`avg confidence: ${(result.coverage.avg_confidence * 100).toFixed(0)}%`);
      lines.push(
        `concepts bound: ${compactCount(result.coverage.concepts_with_bindings)}/${compactCount(result.coverage.concepts_total)}`,
      );
      if (result.coverage.drifted > 0) {
        lines.push(
          `⚠ ${compactCount(result.coverage.drifted)} drifted binding(s) — run ingest() to refresh`,
        );
      }
    }
  }

  if (result.suggestions.length > 0) {
    lines.push("\n## Suggestions\n");
    for (const s of result.suggestions) {
      if (s.action === "connect" && s.concepts.length >= 2) {
        lines.push(`- **Connect** ${s.concepts[0]} ↔ ${s.concepts[1]} — ${s.reason}`);
      } else {
        lines.push(`- ${s.reason}`);
      }
    }
  }

  return lines.join("\n");
}

export function formatLs(result: {
  lore_mind: { name: string } & RegistryEntry;
  concepts: ConceptRow[];
  openNarratives: NarrativeRow[];
  debt: number;
  debt_trend: string;
  concept_symbol_counts?: Record<string, number>;
}): string {
  const lines: string[] = [];
  const debtValue = result.debt;
  const debt = `${debtValue.toFixed(1)}%`;
  lines.push(
    `**${result.lore_mind.name}** · ${compactCount(result.concepts.length)} concepts · debt ${debt}\n`,
  );

  if (result.concepts.length > 0) {
    lines.push("| Concept | Ground | Lore | Churn | Staleness | Symbols | Cluster |");
    lines.push("|---------|--------|------|-------|-----------|---------|---------|");
    for (const c of result.concepts) {
      const ground = c.ground_residual != null ? `${(c.ground_residual * 100).toFixed(0)}%` : "—";
      const lore = c.lore_residual != null ? `${(c.lore_residual * 100).toFixed(0)}%` : "—";
      const churn = c.churn != null ? `${(c.churn * 100).toFixed(0)}%` : "—";
      const staleness = c.staleness != null ? `${(c.staleness * 100).toFixed(0)}%` : "—";
      const symbols = result.concept_symbol_counts?.[c.id] ?? 0;
      const pressure = (c.ground_residual ?? c.churn ?? 0) * 0.6 + (c.lore_residual ?? 0) * 0.4;
      const hub = c.is_hub === 1 ? "*" : "";
      const warn = pressure > 0.5 ? " ⚠" : "";
      lines.push(
        `| ${c.name}${hub}${warn} | ${ground} | ${lore} | ${churn} | ${staleness} | ${compactCount(symbols)} | ${c.cluster ?? "—"} |`,
      );
    }
  }

  if (result.openNarratives.length > 0) {
    lines.push("\n## Active Narratives\n");
    for (const d of result.openNarratives) {
      const theta = d.theta != null ? `θ=${d.theta.toFixed(1)}°` : "θ=—";
      lines.push(`- **${d.name}**: ${compactCount(d.entry_count)} entries, ${theta}`);
    }
  }

  return lines.join("\n");
}

export function formatShow(
  conceptName: string,
  result: {
    concept: ConceptRow;
    content: string | null;
    commit?: { id: string; committed_at: string };
    diff_from_current?: {
      hunks: Array<{
        oldStart: number;
        newStart: number;
        lines: Array<{ type: "context" | "add" | "remove"; text: string }>;
      }>;
      adds: number;
      removes: number;
    };
  },
): string {
  const lines: string[] = [];
  if (result.commit) {
    lines.push(`*commit: ${result.commit.id} (${timeAgo(result.commit.committed_at)})*\n`);
  }
  lines.push(`## ${conceptName}\n`);

  // Metadata line with concept health
  const metaParts: string[] = [];
  const c = result.concept;
  if (c.ground_residual != null) metaParts.push(`ground: ${(c.ground_residual * 100).toFixed(0)}%`);
  if (c.lore_residual != null) metaParts.push(`lore: ${(c.lore_residual * 100).toFixed(0)}%`);
  if (c.staleness != null) {
    const label = c.staleness > 0.5 ? "high" : c.staleness > 0.3 ? "medium" : "low";
    metaParts.push(`staleness: ${label}`);
  }
  if (c.cluster != null) metaParts.push(`cluster: ${c.cluster}`);
  if (c.is_hub === 1) metaParts.push("hub");
  if (metaParts.length > 0) {
    lines.push(`*${metaParts.join(" · ")}*\n`);
  }

  if (result.content) {
    lines.push(result.content);
  } else {
    lines.push("*No content for this concept.*");
  }

  if (result.diff_from_current && result.diff_from_current.hunks.length > 0) {
    lines.push("");
    lines.push(`## Changes since this version`);
    lines.push(`+${result.diff_from_current.adds}/-${result.diff_from_current.removes} lines`);
    lines.push("");
    lines.push("```diff");
    for (const hunk of result.diff_from_current.hunks) {
      lines.push(`@@ old:${hunk.oldStart} new:${hunk.newStart} @@`);
      for (const line of hunk.lines) {
        const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
        lines.push(`${prefix}${line.text}`);
      }
    }
    lines.push("```");
  }

  return lines.join("\n");
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
  const ground =
    c.ground_residual != null
      ? `${(c.ground_residual * 100).toFixed(0)}%`
      : c.churn != null
        ? `${(c.churn * 100).toFixed(0)}% (churn)`
        : "—";
  const lore = c.lore_residual != null ? `${(c.lore_residual * 100).toFixed(0)}%` : "—";
  const staleness =
    c.staleness != null ? (c.staleness > 0.5 ? "high" : c.staleness > 0.3 ? "medium" : "low") : "—";
  const cluster = c.cluster != null ? `cluster ${c.cluster}` : "no cluster";
  lines.push(
    `## ${conceptName}  *(${cluster}, ground ${ground}, lore ${lore}, staleness ${staleness})*\n`,
  );

  // Versions newest-first
  const sorted = [...result.history].reverse();
  for (const entry of sorted) {
    const tag = entry.supersededBy == null ? "**[active]**" : "[superseded]";
    const via = entry.narrative ? ` via narrative **"${entry.narrative.name}"**` : "";
    lines.push(`### v${entry.version}  ${tag}  ${timeAgo(entry.createdAt)}${via}\n`);

    if (entry.narrative) {
      lines.push(`**Intent:** ${entry.narrative.intent}`);
    }
    if (entry.drift != null) {
      lines.push(`**Drift:** ${(entry.drift * 100).toFixed(0)}% (from v${entry.version - 1})`);
    }
    if (entry.journalSnippets && entry.journalSnippets.length > 0) {
      lines.push("**Journal:**");
      for (const s of entry.journalSnippets) {
        lines.push(`- "${s}${s.length >= 100 ? "..." : ""}"`);
      }
    }
    if (entry.commit) {
      lines.push(`**Commit:** ${entry.commit.id} — ${entry.commit.message}`);
    }

    // Content preview
    const preview = entry.content.slice(0, 200).trim();
    lines.push(`\n${preview}${entry.content.length > 200 ? "..." : ""}\n`);
  }

  return lines.join("\n");
}

export function formatLifecycleResult(result: {
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
    lines.push("Preview only — no changes applied.");
  } else if (result.commit_id) {
    lines.push(`Commit: ${result.commit_id}`);
  }
  if (result.affected.length > 0) {
    lines.push(`Affected: ${result.affected.join(", ")}`);
  }
  if (result.proposal?.merged_content) {
    lines.push("");
    lines.push(result.proposal.merged_content);
  }
  if (result.proposal?.splits && result.proposal.splits.length > 0) {
    lines.push("");
    lines.push("## Proposed Splits");
    for (const split of result.proposal.splits) {
      lines.push(`- **${split.name}**`);
      lines.push(`  ${split.content.slice(0, 400)}${split.content.length > 400 ? "..." : ""}`);
    }
  }
  return lines.join("\n");
}

const DIVIDER = "────────────────────────────────────────────────────────────";

function formatStep(step: SuggestionStep, idx: number): string {
  const argParts = Object.entries(step.args)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(", ");
  let line = `  ${idx}. ${step.tool}(${argParts})`;
  if (step.note) line += `  ← ${step.note}`;
  return line;
}

function formatOneSuggestion(s: Suggestion, position: number, total: number): string {
  const lines: string[] = [];
  lines.push(DIVIDER);
  lines.push("");
  const impactPoints =
    s.impact?.expected_debt_reduction_points ?? s.impact?.expected_debt_reduction ?? 0;
  let header = `[${compactCount(position)}/${compactCount(total)}] ${s.kind.toUpperCase()}  confidence: ${(s.confidence * 100).toFixed(0)}%`;
  if (s.impact && impactPoints > 0) {
    header += `  impact: -${(s.impact.percentage_of_total * 100).toFixed(0)}% debt`;
  }
  lines.push(header);
  lines.push(s.title);
  lines.push("");
  if (s.impact) {
    if (impactPoints > 0) {
      const rawDetail =
        s.impact.expected_raw_debt_reduction != null
          ? `, raw -${s.impact.expected_raw_debt_reduction.toFixed(3)}`
          : "";
      lines.push(
        `Impact: -${impactPoints.toFixed(2)} debt points (${(s.impact.percentage_of_total * 100).toFixed(0)}% of total${rawDetail}) — ${s.impact.rationale}`,
      );
    } else {
      lines.push(`Impact: ${s.impact.rationale}`);
    }
    lines.push("");
  }
  if (s.steps.length > 0) {
    lines.push("Steps:");
    s.steps.forEach((step, i) => lines.push(formatStep(step, i + 1)));
  } else {
    lines.push(`Note: ${s.rationale}`);
  }
  lines.push("");
  const evidenceParts = Object.entries(s.evidence)
    .map(([k, v]) => `${k}=${v === null ? "null" : JSON.stringify(v)}`)
    .join(", ");
  lines.push(`Evidence: ${evidenceParts}`);
  return lines.join("\n");
}

export function formatSuggest(result: SuggestResult): string {
  const { suggestions, meta } = result;
  const lines: string[] = [];

  const debtStr = meta.total_debt != null ? meta.total_debt.toFixed(1) : "n/a";
  const rawDebtStr = meta.total_raw_debt != null ? meta.total_raw_debt.toFixed(3) : "n/a";
  const fiedlerStr = meta.fiedler_value != null ? meta.fiedler_value.toFixed(2) : "n/a";
  const computedAt = meta.computed_at.replace(/\.\d{3}Z$/, "Z");

  lines.push(`# Lore Suggestions — ${compactCount(suggestions.length)} items`);
  lines.push(
    `ask debt: ${debtStr}/100  raw debt: ${rawDebtStr}  fiedler: ${fiedlerStr}  concepts: ${compactCount(meta.concept_count)}  ${computedAt}`,
  );

  if (!meta.pairwise_computed) {
    lines.push(
      `(pairwise similarity skipped — ${compactCount(meta.concept_count)} concepts exceeds 200 limit)`,
    );
  }

  if (suggestions.length === 0) {
    lines.push("");
    lines.push("No suggestions — lore looks healthy.");
    return lines.join("\n");
  }

  if (
    meta.total_debt != null &&
    meta.projected_debt_after_top_reducers != null &&
    meta.top_debt_reducers &&
    meta.top_debt_reducers.length > 0 &&
    meta.total_debt > 0
  ) {
    const reduction = meta.total_debt - meta.projected_debt_after_top_reducers;
    if (reduction > 0) {
      const pct = ((reduction / meta.total_debt) * 100).toFixed(0);
      lines.push(
        `Debt reduction path: ask debt ${meta.total_debt.toFixed(1)} → ${meta.projected_debt_after_top_reducers.toFixed(1)} (-${pct}%) from top reducers`,
      );
      for (const item of meta.top_debt_reducers) {
        const points = item.expected_debt_reduction_points ?? item.expected_debt_reduction;
        const raw =
          item.expected_raw_debt_reduction != null
            ? `, raw -${item.expected_raw_debt_reduction.toFixed(3)}`
            : "";
        lines.push(
          `  - ${item.kind}: -${points.toFixed(2)} points (${(item.percentage_of_total * 100).toFixed(0)}%${raw}) — ${item.title}`,
        );
      }
    }
  }

  if (meta.total_debt != null && meta.projected_debt_after != null && meta.total_debt > 0) {
    const reduction = meta.total_debt - meta.projected_debt_after;
    if (reduction > 0) {
      const pct = ((reduction / meta.total_debt) * 100).toFixed(0);
      lines.push(
        `Projected impact (shown items): ask debt ${meta.total_debt.toFixed(1)} → ${meta.projected_debt_after.toFixed(1)} (-${pct}%) if all ${compactCount(suggestions.length)} acted on`,
      );
    }
  }
  if (
    meta.total_raw_debt != null &&
    meta.projected_raw_debt_after != null &&
    meta.total_raw_debt > 0
  ) {
    const rawReduction = meta.total_raw_debt - meta.projected_raw_debt_after;
    if (rawReduction > 0) {
      lines.push(
        `Projected raw debt (diagnostic): ${meta.total_raw_debt.toFixed(3)} → ${meta.projected_raw_debt_after.toFixed(3)} (-${rawReduction.toFixed(3)})`,
      );
    }
  }

  for (let i = 0; i < suggestions.length; i++) {
    lines.push(formatOneSuggestion(suggestions[i]!, i + 1, suggestions.length));
  }

  lines.push("");
  lines.push(DIVIDER);

  return lines.join("\n");
}

export function formatBindings(bindings: ConceptBindingSummary[]): string {
  if (bindings.length === 0) return "";

  const lines: string[] = ["## Bindings"];
  lines.push("| Symbol | Kind | File | Line | Type | Confidence |");
  lines.push("|--------|------|------|------|------|------------|");
  for (const b of bindings) {
    lines.push(
      `| ${b.symbol_name} | ${b.symbol_kind} | ${b.file_path} | ${b.line_start} | ${b.binding_type} | ${(b.confidence * 100).toFixed(0)}% |`,
    );
  }
  return lines.join("\n");
}

export interface TreeDiffFormatOptions {
  page?: number;
  pageSize?: number;
}

export function formatTreeDiff(diff: TreeDiff, opts?: TreeDiffFormatOptions): string {
  const page = opts?.page ?? 1;
  const pageSize = opts?.pageSize ?? 5;
  const lines: string[] = [];

  // Summary header (always shown)
  const totalChanges = diff.added.length + diff.modified.length + diff.removed.length;
  const totalPages = Math.max(1, Math.ceil(totalChanges / pageSize));
  const clampedPage = Math.max(1, Math.min(page, totalPages));

  if (diff.narrative) {
    lines.push(`**Narrative:** ${diff.narrative.name} — ${diff.narrative.intent}`);
    lines.push(`**Entries:** ${compactCount(diff.narrative.entryCount)}`);
  }

  lines.push(
    `**Changes:** +${compactCount(diff.added.length)} ~${compactCount(diff.modified.length)} -${compactCount(diff.removed.length)} (${compactCount(totalChanges)} total)`,
  );
  if (totalPages > 1) {
    lines.push(
      `**Page ${compactCount(clampedPage)}/${compactCount(totalPages)}** (${compactCount(pageSize)} per page)`,
    );
  }
  lines.push("");

  // Lifecycle events — cap at 10 with count
  if (diff.lifecycleEvents && diff.lifecycleEvents.length > 0) {
    const maxEvents = 10;
    const shown = diff.lifecycleEvents.slice(0, maxEvents);
    const remaining = diff.lifecycleEvents.length - shown.length;
    lines.push("### Lifecycle Events");
    for (const evt of shown) {
      lines.push(`- **${evt.type}:** ${evt.description} (${timeAgo(evt.committedAt)})`);
    }
    if (remaining > 0) {
      lines.push(`*...and ${compactCount(remaining)} more lifecycle event(s)*`);
    }
    lines.push("");
  }

  // Build a flat list of all changes for pagination: added, modified, removed (in that order)
  type ChangeEntry =
    | { kind: "added"; item: TreeDiff["added"][number] }
    | { kind: "modified"; item: TreeDiff["modified"][number] }
    | { kind: "removed"; item: TreeDiff["removed"][number] };

  const allChanges: ChangeEntry[] = [
    ...diff.added.map((item) => ({ kind: "added" as const, item })),
    ...diff.modified.map((item) => ({ kind: "modified" as const, item })),
    ...diff.removed.map((item) => ({ kind: "removed" as const, item })),
  ];

  const startIdx = (clampedPage - 1) * pageSize;
  const pageItems = allChanges.slice(startIdx, startIdx + pageSize);

  for (const entry of pageItems) {
    if (entry.kind === "added") {
      const a = entry.item;
      lines.push(`+ **${a.conceptName}**`);
      if (a.newContent) {
        const preview = a.newContent.split("\n").slice(0, 20);
        lines.push("```");
        lines.push(preview.join("\n"));
        if (a.newContent.split("\n").length > 20) lines.push("...");
        lines.push("```");
      } else if (a.contentPreview) {
        lines.push(`  ${a.contentPreview}${a.contentPreview.length >= 200 ? "..." : ""}`);
      }
    } else if (entry.kind === "modified") {
      const m = entry.item;
      const delta =
        m.lengthDelta != null ? ` (${m.lengthDelta >= 0 ? "+" : ""}${m.lengthDelta} chars)` : "";
      lines.push(`~ **${m.conceptName}**${delta}`);
      if (m.oldContent != null && m.newContent != null) {
        if (m.oldContent === m.newContent) {
          lines.push("  No content changes");
        } else if (isDiffTooLarge(m.oldContent, m.newContent)) {
          lines.push("  Content too large for inline diff");
          if (m.contentPreview) {
            lines.push(`  ${m.contentPreview}${m.contentPreview.length >= 200 ? "..." : ""}`);
          }
        } else {
          const hunks = computeLineDiff(m.oldContent, m.newContent);
          if (hunks.length > 0) {
            lines.push("```diff");
            for (const hunk of hunks) {
              lines.push(`@@ old:${hunk.oldStart} new:${hunk.newStart} @@`);
              for (const line of hunk.lines) {
                const prefix = line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
                lines.push(`${prefix}${line.text}`);
              }
            }
            lines.push("```");
          }
        }
      } else if (m.contentPreview) {
        lines.push(`  ${m.contentPreview}${m.contentPreview.length >= 200 ? "..." : ""}`);
      }
    } else {
      lines.push(`- **${entry.item.conceptName}**`);
    }
    lines.push("");
  }

  if (totalChanges === 0 && (!diff.lifecycleEvents || diff.lifecycleEvents.length === 0)) {
    lines.push("No changes.");
  }

  if (totalPages > 1 && clampedPage < totalPages) {
    lines.push(`*Use page=${clampedPage + 1} to see more changes*`);
  }

  return lines.join("\n").trimEnd();
}

export function formatCommitLog(entries: CommitLogEntry[]): string {
  if (entries.length === 0) return "No commits yet.";

  const lines: string[] = [];

  for (const entry of entries) {
    lines.push(`### ${entry.id}  ${timeAgo(entry.committedAt)}`);

    if (entry.narrative) {
      lines.push(`**Narrative:** ${entry.narrative.name} — ${entry.narrative.intent}`);
      lines.push(`**Entries:** ${compactCount(entry.narrative.entryCount)}`);
    } else if (entry.lifecycleType) {
      lines.push(
        `**${entry.lifecycleType}:** ${entry.message.replace(/^lifecycle:\s+\S+\s+/, "")}`,
      );
    } else {
      lines.push(entry.message);
    }

    if (entry.diff) {
      const parts: string[] = [];
      if (entry.diff.added.length > 0) parts.push(`+${entry.diff.added.join(", +")}`);
      if (entry.diff.modified.length > 0) parts.push(`~${entry.diff.modified.join(", ~")}`);
      if (entry.diff.removed.length > 0) parts.push(`-${entry.diff.removed.join(", -")}`);
      if (parts.length > 0) {
        lines.push(parts.join("  "));
      }
    }

    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

export function formatNarrativeTrail(result: NarrativeTrailResult): string {
  const lines: string[] = [];
  lines.push(`## ${result.narrative.name}`);
  lines.push(`*${result.narrative.intent}*`);
  lines.push(
    `*${result.narrative.status} · ${compactCount(result.narrative.entry_count)} entries · Topics: ${result.topics_covered.join(", ")}*`,
  );
  lines.push("");
  for (const entry of result.entries) {
    const statusTag = entry.status ? `[${entry.status}] ` : "";
    lines.push(`### Entry ${entry.position}`);
    lines.push(`*${statusTag}${timeAgo(entry.created_at)}*`);
    if (entry.topics.length > 0) lines.push(`*Topics: ${entry.topics.join(", ")}*`);
    lines.push("");
    lines.push(entry.content);
    lines.push("");
  }
  return lines.join("\n");
}

export function formatBootstrapPlan(plan: BootstrapPlan): string {
  const lines: string[] = [];
  const pct = (plan.progress.coverage_ratio * 100).toFixed(0);
  lines.push(`# Bootstrap Plan — ${compactCount(plan.phases.length)} phases`);
  lines.push(
    `Coverage: ${pct}% (${compactCount(plan.progress.covered_exported)}/${compactCount(plan.progress.total_exported)} exported symbols)`,
  );
  lines.push(
    `Progress: ${compactCount(plan.progress.phases_complete)}/${compactCount(plan.progress.phases_total)} phases complete`,
  );

  if (plan.phases.length === 0) {
    lines.push("");
    lines.push("All exported symbols are covered. No bootstrap work needed.");
    return lines.join("\n");
  }

  for (const phase of plan.phases) {
    lines.push("");
    lines.push(`## ${phase.name}`);
    lines.push(`*${phase.rationale}*`);
    lines.push(
      `${compactCount(phase.total_symbols)} uncovered symbols across ${compactCount(phase.files.length)} files`,
    );
    lines.push("");
    for (const f of phase.files) {
      const syms = f.symbols.map((s) => s.name).join(", ");
      const more =
        f.uncovered_count > f.symbols.length
          ? ` (+${compactCount(f.uncovered_count - f.symbols.length)} more)`
          : "";
      lines.push(
        `- **${f.file_path}** — ${compactCount(f.uncovered_count)}/${compactCount(f.total_exported)} uncovered: ${syms}${more}`,
      );
    }
  }

  return lines.join("\n");
}
