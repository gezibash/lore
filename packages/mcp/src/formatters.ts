import { renderAsk, renderAskBrief, renderRecall, type RecallSection } from "@lore/rendering";
import type { ConceptBindingSummary, ConceptRelationSummary, LoreConfig, QueryResult, RecallResult } from "@lore/worker";
import { formatBindings } from "@lore/worker";

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

export function formatAskMcp(
  result: QueryResult,
  opts?: {
    includeSources?: boolean;
  },
): string {
  return renderAsk(result, { route: "mcp", includeSources: opts?.includeSources });
}

export function formatAskMcpBrief(result: QueryResult): string {
  return renderAskBrief(result, { route: "mcp" });
}

export type { RecallSection };

export function formatRecallMcp(
  recalled: RecallResult,
  section: RecallSection = "full",
): string {
  return renderRecall(recalled, section);
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
