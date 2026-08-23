import type { ExecutiveSummary } from "./types.ts";
import { timeAgo } from "@lore/core";

/** Characters that make a position "inside a word" for citation matching.
 *  JS `\b` is ASCII-only (`\w` is [A-Za-z0-9_]), and it also fails for terms
 *  that begin or end with punctuation — `\b--direction\b` cannot match
 *  "use --direction up". Asserting the neighbours are not word characters
 *  handles both, and stays correct for non-ASCII prose. */
const WORD_ADJACENT = "[\\p{L}\\p{N}_]";

/** Match `term` only as a whole word. Returns null for a term that cannot
 *  produce a usable pattern, which drops it rather than citing everything. */
function termPattern(term: string): RegExp | null {
  const trimmed = term.trim();
  if (trimmed.length === 0) return null;
  try {
    return new RegExp(`(?<!${WORD_ADJACENT})${RegExp.escape(trimmed)}(?!${WORD_ADJACENT})`, "iu");
  } catch {
    return null;
  }
}

/** A line that already carries a citation. The range form is what the model
 *  itself writes ([file.ts:19-24]); missing it let the weaker injected
 *  citation pile onto the line the model had already sourced properly. */
const ALREADY_CITED = /\[[^\]]+:\d+(?:-\d+)?\]/;

/**
 * Apply per-term inline [file:line] citations to narrative text.
 *
 * A citation is attached to a line only when that line names the citation's
 * term as a whole word. Substring matching used to be enough, which cited a
 * sentence about KPI flags to the daemon RPC client because "automatically"
 * contains "call" and a concept is named `call`. Deduplicates by file:line so
 * one location is never cited on two lines.
 *
 * These citations are injected after generation, so they are weaker evidence
 * than the [file:line-range] references the model writes while reading the
 * pack: the injector never saw the claim it is attaching to.
 */
export function renderNarrativeWithCitations(
  narrative: string,
  citations: ExecutiveSummary["citations"],
  opts?: { exactness?: boolean },
): string {
  if (citations.length === 0 || narrative.length === 0) return narrative;

  const patterns = citations.map((citation) => (citation.term ? termPattern(citation.term) : null));
  const lines = narrative.split("\n");
  const usedHits = new Set<number>();
  const usedLocations = new Set<string>();
  let attachedAny = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue;
    if (ALREADY_CITED.test(line)) continue;
    const matched: string[] = [];
    for (let h = 0; h < citations.length; h++) {
      if (usedHits.has(h)) continue;
      const hit = citations[h]!;
      const loc = `${hit.file}:${hit.line}`;
      if (usedLocations.has(loc)) {
        usedHits.add(h);
        continue;
      }
      if (patterns[h]?.test(line)) {
        matched.push(`[${loc}]`);
        usedHits.add(h);
        usedLocations.add(loc);
      }
    }
    if (matched.length > 0) {
      lines[i] = `${line}  ${matched.join(" ")}`;
      attachedAny = true;
    }
  }

  // Exactness fallback. This used to staple the same top-3 citations onto the
  // first three content lines unconditionally, which is where identical
  // citation triples repeating under every bullet came from — each line looked
  // individually sourced when nothing had been matched at all. Now it runs
  // only when no line earned a citation, and marks one line, so the answer
  // still carries file references without implying per-claim attribution.
  if (!attachedAny && opts?.exactness) {
    const citationStr = citations
      .slice(0, 3)
      .map((c) => `[${c.file}:${c.line}]`)
      .join(" ");
    const target = lines.findIndex((line) => line.trim().length > 0 && !ALREADY_CITED.test(line));
    // No eligible line means the model already cited every line itself, and
    // its own references are the better ones.
    if (citationStr && target >= 0) {
      lines[target] = `${lines[target]}  ${citationStr}`;
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

    const oldest = sources
      .map((s) => s.last_updated)
      .filter(Boolean)
      .sort()[0];
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
