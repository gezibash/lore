import type { ExecutiveSummary } from "./types.ts";
import { timeAgo } from "@lore/core";

/**
 * Apply per-term inline [file:line] citations to narrative text.
 *
 * In exactness mode, attach all citations to the first few content lines.
 * In general mode, attach per-term: only cite a hit on a line that mentions its term.
 * Deduplicates by file:line so the same location isn't cited on multiple lines.
 */
export function renderNarrativeWithCitations(
  narrative: string,
  citations: ExecutiveSummary["citations"],
  opts?: { exactness?: boolean },
): string {
  if (citations.length === 0 || narrative.length === 0) return narrative;

  if (opts?.exactness) {
    const citationStr = citations
      .slice(0, 3)
      .map((c) => `[${c.file}:${c.line}]`)
      .join(" ");
    if (!citationStr) return narrative;
    const lines = narrative.split("\n");
    let attached = 0;
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i]!.trim();
      if (trimmed.length === 0) continue;
      if (/\[[^\]]+:\d+\]/.test(trimmed)) continue;
      lines[i] = `${lines[i]} ${citationStr}`;
      attached++;
      if (attached >= 3) break;
    }
    if (attached === 0 && lines.length > 0) {
      lines[0] = `${lines[0]} ${citationStr}`;
    }
    return lines.join("\n");
  }

  // General mode: per-term matching
  const lines = narrative.split("\n");
  const usedHits = new Set<number>();
  const usedLocations = new Set<string>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const lower = line.toLowerCase();
    if (lower.trim().length === 0) continue;
    if (/\[[^\]]+:\d+\]/.test(line)) continue;
    const matched: string[] = [];
    for (let h = 0; h < citations.length; h++) {
      if (usedHits.has(h)) continue;
      const hit = citations[h]!;
      const loc = `${hit.file}:${hit.line}`;
      if (usedLocations.has(loc)) {
        usedHits.add(h);
        continue;
      }
      if (hit.term && lower.includes(hit.term.toLowerCase())) {
        matched.push(`[${loc}]`);
        usedHits.add(h);
        usedLocations.add(loc);
      }
    }
    if (matched.length > 0) {
      lines[i] = `${line}  ${matched.join(" ")}`;
    }
  }
  return lines.join("\n");
}

/**
 * Build a provenance footer from structured ExecutiveSummary data.
 * Includes concept names, file counts, key files, and staleness warnings.
 */
export function renderProvenance(summary: ExecutiveSummary): string {
  const { sources, counts } = summary;

  // If we have named sources, use attributed provenance
  if (sources.length > 0) {
    const names = sources.map((s) => s.concept);
    const conceptStr =
      names.length <= 4
        ? names.join(", ")
        : `${names.slice(0, 3).join(", ")} (+${names.length - 3} more)`;

    const allFiles = [...new Set(sources.flatMap((s) => s.files))];
    const parts: string[] = [];
    parts.push(
      `${sources.length} matched concept${sources.length === 1 ? "" : "s"} (${conceptStr})`,
    );
    parts.push(`${allFiles.length} source file${allFiles.length === 1 ? "" : "s"}`);
    if (counts.symbols > 0) {
      parts.push(`${counts.symbols} symbol${counts.symbols === 1 ? "" : "s"}`);
    }

    const lines: string[] = [`Based on ${parts.join(", ")}.`];

    const oldest = sources.map((s) => s.last_updated).filter(Boolean).sort()[0];
    if (oldest) {
      lines[0] += ` Oldest source: ${timeAgo(oldest)}.`;
    }

    if (allFiles.length > 0) {
      const fileStr =
        allFiles.length <= 5
          ? allFiles.join(", ")
          : `${allFiles.slice(0, 4).join(", ")} (+${allFiles.length - 4} more)`;
      lines.push(`Key files: ${fileStr}`);
    }

    const stale = sources.filter((s) => s.staleness != null && s.staleness > 0.5);
    if (stale.length > 0) {
      const staleNames = stale
        .slice(0, 3)
        .map((s) => s.concept)
        .join(", ");
      lines.push(`\u26A0 Possibly outdated: ${staleNames}`);
    }

    return lines.join("\n");
  }

  // Fallback: count-based provenance
  const parts: string[] = [`${counts.concepts} concept${counts.concepts === 1 ? "" : "s"}`];
  parts.push(`${counts.files} source file${counts.files === 1 ? "" : "s"}`);
  if (counts.symbols > 0) {
    parts.push(`${counts.symbols} symbol${counts.symbols === 1 ? "" : "s"}`);
  }
  return `Based on ${parts.join(", ")}.`;
}

/**
 * Render a full executive summary as text: narrative + citations + provenance.
 * Handles all kinds (generated, fallback, uncertain).
 */
export function renderExecutiveSummary(
  summary: ExecutiveSummary,
  opts?: { exactness?: boolean },
): string {
  if (summary.kind === "uncertain") {
    const uncertain = summary.uncertainty_reason
      ? `Uncertain: ${summary.uncertainty_reason}`
      : "Uncertain";
    const provenance = renderProvenance(summary);
    return provenance ? `${uncertain}\n\n${provenance}` : uncertain;
  }

  if (summary.narrative.length === 0) {
    return renderProvenance(summary);
  }

  const narrative =
    summary.citations.length > 0
      ? renderNarrativeWithCitations(summary.narrative, summary.citations, opts)
      : summary.narrative;
  const provenance = renderProvenance(summary);
  return provenance ? `${narrative}\n\n${provenance}` : narrative;
}
