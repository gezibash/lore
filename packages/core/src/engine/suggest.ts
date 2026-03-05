import type { Database } from "bun:sqlite";
import { getActiveConcepts, getConceptRelations } from "@/db/index.ts";
import { getEdges } from "@/db/edges.ts";
import { getAllEmbeddings } from "@/db/embeddings.ts";
import { getOpenNarratives } from "@/db/index.ts";
import { getManifest } from "@/db/manifest.ts";
import { getLaplacianCache } from "@/db/laplacian.ts";
import { getConcept } from "@/db/concepts.ts";
import { getFilesForConcept } from "@/db/concept-symbols.ts";
import { pairwiseCosineSimilarity } from "./graph.ts";
import { computeDebtSnapshot, conceptPressure } from "./debt.ts";
import type {
  ConceptRow,
  ConceptRelationRow,
  LoreConfig,
  RegistryEntry,
  SuggestionKind,
  SuggestionImpact,
} from "@/types/index.ts";
import type { Suggestion, SuggestResult, SuggestionStep } from "@/types/index.ts";
import { getUncoveredSymbols, getFileCoverage, getCoverageStats, getConceptCoverage } from "@/db/concept-symbols.ts";
import { computeAskDebtSnapshot, type AskDebtSnapshot } from "./ask-debt.ts";
import { readSymbolContent } from "./git.ts";

const PAIRWISE_CONCEPT_LIMIT = 200;
const MERGE_SIM_THRESHOLD = 0.92;
const RELATE_SIM_LOW = 0.7;
const RELATE_SIM_HIGH = 0.92;
const REVIEW_RESIDUAL_THRESHOLD = 0.65;
const REVIEW_TOP_N = 5;
const ARCHIVE_STALENESS_THRESHOLD = 0.7;
const DANGLING_DAYS = 3;

const SYMBOL_DRIFT_PRIORITY = 2;
const COVERAGE_GAP_PRIORITY = 3;
const KNOWLEDGE_PULL_PRIORITY = 3;
const MERGE_PRIORITY = 3;
const RELATE_PRIORITY = 4;
const REVIEW_PRIORITY = 5;
const CLUSTER_DRIFT_PRIORITY = 6;
const ARCHIVE_PRIORITY = 7;

function daysSince(isoDate: string): number {
  return (Date.now() - new Date(isoDate).getTime()) / (24 * 60 * 60 * 1000);
}

function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function getConceptFiles(db: Database, concept: ConceptRow): string[] {
  return getFilesForConcept(db, concept.id);
}

export async function computeSuggestions(
  db: Database,
  codePath: string,
  opts?: { limit?: number; kind?: SuggestionKind | SuggestionKind[] },
  ctx?: {
    entry?: RegistryEntry;
    config?: LoreConfig;
    askDebtSnapshot?: AskDebtSnapshot;
    generator?: import("./generator.ts").Generator;
  },
): Promise<SuggestResult> {
  const limit = opts?.limit ?? 10;
  const kindFilter = opts?.kind ? (Array.isArray(opts.kind) ? opts.kind : [opts.kind]) : null;
  const suggestions: Suggestion[] = [];

  const manifest = getManifest(db);
  const laplacian = getLaplacianCache(db);
  const activeConcepts = getActiveConcepts(db);
  const conceptById = new Map<string, ConceptRow>(activeConcepts.map((c) => [c.id, c]));
  const conceptByName = new Map<string, ConceptRow>(activeConcepts.map((c) => [c.name, c]));

  // Compute live debt (includes ref-drift pressure not yet committed to manifest)
  const debtSnapshot = await computeDebtSnapshot(
    { code_path: codePath, lore_path: "", registered_at: "" },
    db,
    activeConcepts,
    manifest,
  );
  const liveDebt = debtSnapshot.live_debt;
  const rawDebt = debtSnapshot.debt;
  const askDebtSnapshot = ctx?.askDebtSnapshot
    ?? (
      ctx?.entry && ctx?.config
        ? computeAskDebtSnapshot({
          db,
          entry: ctx.entry,
          config: ctx.config,
          concepts: activeConcepts,
          debtSnapshot,
        })
        : null
    );
  const totalDebt = askDebtSnapshot?.debt ?? liveDebt;
  const fiedlerValue = laplacian?.fiedler_value ?? manifest?.fiedler_value ?? 0;
  const fiedlerDivisor = 1 + fiedlerValue;
  const { refDriftScoreByConcept } = debtSnapshot;

  function impactForConcept(concept: ConceptRow, fraction: number = 1.0, rationale: string): SuggestionImpact {
    const pressure = conceptPressure(concept, refDriftScoreByConcept);
    const rawReduction = (pressure * fraction) / fiedlerDivisor;
    const pointReduction = rawDebt > 0
      ? (rawReduction / rawDebt) * totalDebt
      : rawReduction;
    return {
      expected_debt_reduction: pointReduction,
      expected_debt_reduction_points: pointReduction,
      expected_raw_debt_reduction: rawReduction,
      percentage_of_total: totalDebt > 0 ? pointReduction / totalDebt : 0,
      rationale,
    };
  }

  const ZERO_IMPACT: SuggestionImpact = {
    expected_debt_reduction: 0,
    expected_debt_reduction_points: 0,
    expected_raw_debt_reduction: 0,
    percentage_of_total: 0,
    rationale: "No direct debt reduction",
  };

  // ── 1. Dangling narratives ──────────────────────────────────
  const openNarratives = getOpenNarratives(db);
  for (const narrative of openNarratives) {
    const age = daysSince(narrative.opened_at);
    if (age <= DANGLING_DAYS) continue;

    if (narrative.entry_count > 0) {
      suggestions.push({
        kind: "close-narrative",
        priority: 1,
        confidence: 1.0,
        title: `"${narrative.name}" open ${Math.floor(age)} days (${narrative.entry_count} entries)`,
        rationale: "Narrative has been open beyond the dangling threshold with recorded entries.",
        steps: [{ tool: "close", args: { narrative: narrative.name } }],
        concepts: [],
        evidence: {
          opened_at: narrative.opened_at,
          entry_count: narrative.entry_count,
          age_days: Math.floor(age),
        },
        impact: { ...ZERO_IMPACT, rationale: "Closing integrates knowledge; may reduce drift-based debt" },
      });
    } else {
      suggestions.push({
        kind: "abandon-narrative",
        priority: 1,
        confidence: 1.0,
        title: `"${narrative.name}" open ${Math.floor(age)} days (0 entries)`,
        rationale: "Narrative has been open beyond the dangling threshold with no entries recorded.",
        steps: [
          {
            tool: "open",
            args: {
              narrative: "<your-next-narrative>",
              intent: "<intent>",
              resolve_dangling: { narrative: narrative.name, action: "abandon" },
            },
            note: "Fill in narrative name and intent for your next exploration",
          },
        ],
        concepts: [],
        evidence: {
          opened_at: narrative.opened_at,
          entry_count: 0,
          age_days: Math.floor(age),
        },
        impact: ZERO_IMPACT,
      });
    }
  }

  // ── 2. Stale relations ──────────────────────────────────
  const allRelations = getConceptRelations(db);
  for (const rel of allRelations) {
    const target = getConcept(db, rel.to_concept_id);
    if (!target) continue;
    if (target.lifecycle_status === "active" || target.lifecycle_status == null) continue;

    const fromConcept = conceptById.get(rel.from_concept_id);
    const fromName = fromConcept?.name ?? rel.from_concept_id;
    const toName = target.name;

    suggestions.push({
      kind: "clean-relation",
      priority: 1,
      confidence: 1.0,
      title: `${fromName} → ${toName} (${rel.relation_type}) — target is ${target.lifecycle_status}`,
      rationale: `Relation points to a ${target.lifecycle_status} concept and should be removed.`,
      steps: [
        {
          tool: "relate",
          args: { from: fromName, to: toName, type: rel.relation_type, remove: true },
        },
      ],
      concepts: [fromName, toName],
      evidence: {
        target_lifecycle: target.lifecycle_status,
        archived_at: target.archived_at,
      },
      impact: { ...ZERO_IMPACT, rationale: "Cleanup; removes stale graph edge" },
    });
  }

  // ── 3. Symbol drift ──────────────────────────────────────
  // Surface symbol-level drift from concept_symbols bindings.
  const symbolDriftWarnings = debtSnapshot.symbolDriftWarnings;

  for (const [conceptId, drifts] of symbolDriftWarnings) {
    const concept = conceptById.get(conceptId);
    if (!concept) continue;

    const slug = toSlug(concept.name);
    const reviewNarrative = `review-${slug}`;

    // Generate targeted investigation questions via LLM when available.
    // Uses bound_body (old) vs current body from disk to produce specific questions.
    let investigationQuestions: string[] | undefined;
    if (ctx?.generator && drifts.length > 0) {
      try {
        const firstDrift = drifts[0]!;
        const oldBody = firstDrift.bound_body ?? null;
        const newBody = await readSymbolContent(
          codePath,
          firstDrift.file_path,
          firstDrift.line_start,
          firstDrift.line_end,
        );
        if (oldBody && newBody) {
          const qs = await ctx.generator.generateDriftQuestions(
            concept.name,
            firstDrift.symbol_name,
            oldBody,
            newBody,
          );
          if (qs.length > 0) investigationQuestions = qs;
        }
      } catch {
        // Degrade gracefully — questions are best-effort
      }
    }

    const writeNote = investigationQuestions && investigationQuestions.length > 0
      ? `Answer these questions:\n${investigationQuestions.map((q, i) => `${i + 1}. ${q}`).join("\n")}`
      : "Document what changed in the bound symbols and update the concept accordingly";

    suggestions.push({
      kind: "symbol-drift",
      priority: SYMBOL_DRIFT_PRIORITY,
      confidence: Math.min(1, 0.5 + drifts.length * 0.15),
      title: `${concept.name} — ${drifts.length} bound symbol(s) changed`,
      rationale:
        "Symbols bound to this concept have changed since the last binding. The concept content may be stale.",
      steps: [
        {
          tool: "open",
          args: {
            narrative: reviewNarrative,
            intent: `Update concept after symbol changes: ${concept.name}`,
          },
        },
        { tool: "show", args: { concept: concept.name } },
        {
          tool: "write",
          args: { narrative: reviewNarrative, entry: "…", topics: [concept.name] },
          note: writeNote,
        },
        { tool: "close", args: { narrative: reviewNarrative } },
      ],
      concepts: [concept.name],
      evidence: {
        drifted_symbols: drifts.map((d) => ({
          name: d.symbol_name,
          kind: d.symbol_kind,
          file: d.file_path,
          qualified_name: d.symbol_qualified_name,
        })),
        drift_count: drifts.length,
        investigation_questions: investigationQuestions,
      },
      impact: impactForConcept(concept, 0.7, "Resolving symbol drift reduces concept pressure"),
    });
  }

  // ── 3c. Coverage gaps ─────────────────────────────────────
  // Surface directory groups with uncovered exported symbols, ordered by depth/importance.
  try {
    const fileCoverage = getFileCoverage(db);
    const uncoveredExported = getUncoveredSymbols(db, { exportedOnly: true, limit: 500 });

    // Group uncovered exported symbols by file
    const uncoveredByFile = new Map<string, Array<{ name: string; kind: string }>>();
    for (const sym of uncoveredExported) {
      let list = uncoveredByFile.get(sym.file_path);
      if (!list) {
        list = [];
        uncoveredByFile.set(sym.file_path, list);
      }
      list.push({ name: sym.name, kind: sym.kind });
    }

    // Get per-file total counts for confidence calculation
    const fileSymbolCounts = new Map<string, number>();
    for (const fc of fileCoverage) {
      fileSymbolCounts.set(fc.file_path, fc.symbol_count);
    }

    // Group files by directory prefix (first 2 path segments)
    const byDir = new Map<string, Array<{ filePath: string; syms: Array<{ name: string; kind: string }> }>>();
    for (const [filePath, syms] of uncoveredByFile) {
      const parts = filePath.split("/");
      const dir = parts.length <= 2 ? (parts[0] ?? ".") : parts.slice(0, 2).join("/");
      let files = byDir.get(dir);
      if (!files) {
        files = [];
        byDir.set(dir, files);
      }
      files.push({ filePath, syms });
    }

    // Score and sort directory groups
    const MIN_UNCOVERED_PER_GROUP = 2;
    const MAX_COVERAGE_GAPS = 8;

    interface DirGroupEntry {
      dir: string;
      files: Array<{ filePath: string; syms: Array<{ name: string; kind: string }> }>;
      totalUncovered: number;
      score: number;
    }

    const dirGroups: DirGroupEntry[] = [];
    for (const [dir, files] of byDir) {
      const totalUncovered = files.reduce((acc, f) => acc + f.syms.length, 0);
      if (totalUncovered < MIN_UNCOVERED_PER_GROUP) continue;

      const depth = dir.split("/").length;
      const depthScore = (10 - Math.min(depth, 9)) * 100;
      const countScore = totalUncovered * 10;
      let kindScore = 0;
      for (const f of files) {
        for (const s of f.syms) {
          const k = s.kind;
          kindScore += k === "interface" || k === "type" || k === "enum" ? 3 : k === "class" ? 1.5 : k === "function" ? 1 : 0.5;
        }
      }
      dirGroups.push({ dir, files, totalUncovered, score: depthScore + countScore + kindScore });
    }

    dirGroups.sort((a, b) => b.score - a.score);

    let coverageGapCount = 0;
    for (const group of dirGroups) {
      if (coverageGapCount >= MAX_COVERAGE_GAPS) break;

      const totalInGroup = group.files.reduce(
        (acc, f) => acc + (fileSymbolCounts.get(f.filePath) ?? f.syms.length),
        0,
      );
      const confidence = Math.min(1, group.totalUncovered / Math.max(1, totalInGroup));
      const slug = toSlug(group.dir);
      const coverageNarrative = `bootstrap-${slug}`;
      const fileCount = group.files.length;
      const fileWord = fileCount === 1 ? "file" : "files";

      // First group gets higher priority
      const priority = coverageGapCount === 0 ? SYMBOL_DRIFT_PRIORITY : COVERAGE_GAP_PRIORITY;

      // Build rationale with phase context
      const depth = group.dir.split("/").length;
      const typeCount = group.files.reduce(
        (acc, f) => acc + f.syms.filter((s) => s.kind === "interface" || s.kind === "type" || s.kind === "enum").length,
        0,
      );
      const rationaleParts: string[] = [];
      if (coverageGapCount === 0) rationaleParts.push("Start here:");
      if (depth <= 2) rationaleParts.push("shallow directory (foundational)");
      if (typeCount > 0) rationaleParts.push(`${typeCount} type definitions`);
      rationaleParts.push(
        `Use \`bind\` to attach symbols to existing concepts, or open a narrative to document new areas.`,
      );
      const rationale = rationaleParts.join(" ");

      const topSymbols = group.files
        .flatMap((f) => f.syms)
        .slice(0, 8)
        .map((s) => s.name);

      suggestions.push({
        kind: "coverage-gap",
        priority,
        confidence,
        title: `Bootstrap ${group.dir}/ — ${fileCount} ${fileWord}, ${group.totalUncovered} exported symbols`,
        rationale,
        steps: [
          {
            tool: "open",
            args: { narrative: coverageNarrative, intent: `Document uncovered symbols in ${group.dir}/` },
            note: "If existing concepts already cover these symbols, use bind(concept, symbol) directly instead.",
          },
          {
            tool: "write",
            args: { narrative: coverageNarrative, entry: "…", topics: ["coverage"] },
            note: `Document ${group.totalUncovered} uncovered exported symbols: ${topSymbols.join(", ")}${group.totalUncovered > topSymbols.length ? "…" : ""}`,
          },
          { tool: "close", args: { narrative: coverageNarrative } },
        ],
        concepts: [],
        evidence: {
          directory: group.dir,
          file_count: fileCount,
          uncovered_count: group.totalUncovered,
          files: group.files.slice(0, 5).map((f) => ({
            path: f.filePath,
            uncovered: f.syms.length,
          })),
        },
        impact: { ...ZERO_IMPACT, rationale: "Improves coverage; no direct debt reduction" },
      });
      coverageGapCount++;
    }
  } catch {
    // symbols/concept_symbols tables may not exist yet — skip silently
  }

  // ── 3d. Knowledge gradient (sink capacity) ───────────────
  // Rank concepts by how much more knowledge they can absorb.
  // Distinct from coverage-gap: this is about semantic depth, not exported symbols.
  // α=0.5 coverage_density, β=0.3 staleness, γ=0.2 ground_residual
  const ALPHA = 0.5;
  const BETA = 0.3;
  const GAMMA = 0.2;
  const MAX_KNOWLEDGE_PULL = 5;

  try {
    const conceptCoverage = getConceptCoverage(db);
    const coverageByConceptId = new Map(conceptCoverage.map((r) => [r.concept_id, r]));

    interface KnowledgePullEntry {
      concept: ConceptRow;
      capacity: number;
    }
    const pullEntries: KnowledgePullEntry[] = [];

    for (const concept of activeConcepts) {
      const coverage = coverageByConceptId.get(concept.id);
      const coverageDensity = coverage
        ? coverage.reachable_count > 0 ? coverage.bound_count / coverage.reachable_count : 0
        : 0;
      const staleness = concept.staleness ?? 0;
      const groundResidual = concept.ground_residual ?? 0;
      const capacity =
        ALPHA * (1 - coverageDensity) + BETA * staleness + GAMMA * groundResidual;
      if (capacity > 0.3) {
        pullEntries.push({ concept, capacity });
      }
    }

    // Also add dark-zone entries: files with no concept bindings at all
    const allFileCoverage = getFileCoverage(db);
    const darkFiles = allFileCoverage
      .filter((f) => f.bound_count === 0 && f.symbol_count >= 3)
      .slice(0, 3);

    pullEntries.sort((a, b) => b.capacity - a.capacity);
    const topPull = pullEntries.slice(0, MAX_KNOWLEDGE_PULL);

    for (const entry of topPull) {
      const slug = toSlug(entry.concept.name);
      const pullNarrative = `deepen-${slug}`;
      const capacityPct = (entry.capacity * 100).toFixed(0);
      suggestions.push({
        kind: "knowledge-pull",
        priority: KNOWLEDGE_PULL_PRIORITY,
        confidence: entry.capacity,
        title: `${entry.concept.name} — capacity ${capacityPct}% (knowledge sink)`,
        rationale: `This concept has high absorption capacity. Journaling here will reduce S_dist most.`,
        steps: [
          {
            tool: "open",
            args: { narrative: pullNarrative, intent: `Deepen knowledge of ${entry.concept.name}` },
          },
          { tool: "show", args: { concept: entry.concept.name } },
          {
            tool: "write",
            args: { narrative: pullNarrative, entry: "…", concepts: [entry.concept.name] },
            note: "Document symbols, invariants, or architectural patterns not yet captured",
          },
          { tool: "close", args: { narrative: pullNarrative } },
        ],
        concepts: [entry.concept.name],
        evidence: {
          capacity: entry.capacity,
          staleness: entry.concept.staleness,
          ground_residual: entry.concept.ground_residual,
          dark_zones: darkFiles.map((f) => ({ file: f.file_path, symbols: f.symbol_count })),
        },
        impact: impactForConcept(
          entry.concept,
          entry.capacity,
          `Filling ${capacityPct}% capacity reduces concept's state distance contribution`,
        ),
      });
    }
  } catch {
    // concept_symbols tables may not exist yet — skip silently
  }

  // ── 4. Pairwise similarity ──────────────────────────────
  const pairwiseComputed = activeConcepts.length <= PAIRWISE_CONCEPT_LIMIT;

  if (pairwiseComputed && activeConcepts.length >= 2) {
    const embeddingRows = getAllEmbeddings(db, "chunk");

    // Map chunk_id -> ConceptRow (via chunk concept_id lookup)
    // getAllEmbeddings returns rows for active concept chunks
    // We need to map chunk_id to concept. Use a db query for active chunk->concept mapping.
    const chunkToConcept = new Map<string, ConceptRow>();
    for (const row of embeddingRows) {
      // Find the concept for this chunk via active_chunk_id
      for (const concept of activeConcepts) {
        if (concept.active_chunk_id === row.chunk_id) {
          chunkToConcept.set(row.chunk_id, concept);
          break;
        }
      }
    }

    // Filter to only chunks that map to a concept
    const mapped = embeddingRows.filter((r) => chunkToConcept.has(r.chunk_id));

    if (mapped.length >= 2) {
      const floats = mapped.map((r) => {
        const bytes = r.embedding instanceof Uint8Array ? r.embedding : new Uint8Array(r.embedding);
        return new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
      });

      const sim = pairwiseCosineSimilarity(floats);

      // Build existing relation pairs set (both orderings)
      const existingRelPairs = new Set<string>();
      for (const rel of allRelations) {
        existingRelPairs.add(`${rel.from_concept_id}|${rel.to_concept_id}`);
        existingRelPairs.add(`${rel.to_concept_id}|${rel.from_concept_id}`);
      }

      for (let i = 0; i < mapped.length; i++) {
        for (let j = i + 1; j < mapped.length; j++) {
          const conceptA = chunkToConcept.get(mapped[i]!.chunk_id)!;
          const conceptB = chunkToConcept.get(mapped[j]!.chunk_id)!;
          if (conceptA.id === conceptB.id) continue;

          const s = sim.get(i, j);
          const hasRelation = existingRelPairs.has(`${conceptA.id}|${conceptB.id}`);

          if (s > MERGE_SIM_THRESHOLD && !hasRelation) {
            // Higher ground_residual = source (less stable), lower = target (more stable)
            const residualA = conceptA.ground_residual ?? conceptA.churn ?? 0;
            const residualB = conceptB.ground_residual ?? conceptB.churn ?? 0;
            const source = residualA >= residualB ? conceptA : conceptB;
            const target = residualA >= residualB ? conceptB : conceptA;
            const filesA = getConceptFiles(db, conceptA);
            const filesB = getConceptFiles(db, conceptB);

            suggestions.push({
              kind: "merge",
              priority: MERGE_PRIORITY,
              confidence: s,
              title: `${conceptA.name} ↔ ${conceptB.name} — cosine similarity ${s.toFixed(2)}, no merge relation`,
              rationale: "Very high embedding similarity with no existing merge relation.",
              steps: [
                {
                  tool: "show",
                  args: { concept: conceptA.name },
                  note: filesA.length > 0 ? `source files: ${filesA.join(", ")}` : undefined,
                },
                {
                  tool: "show",
                  args: { concept: conceptB.name },
                  note: filesB.length > 0 ? `source files: ${filesB.join(", ")}` : undefined,
                },
                { tool: "merge", args: { source: source.name, into: target.name } },
              ],
              concepts: [conceptA.name, conceptB.name],
              evidence: {
                cosine_similarity: s,
                cluster_a: conceptA.cluster,
                cluster_b: conceptB.cluster,
              },
              impact: impactForConcept(source, 1.0, `Merging removes ${source.name} and its debt contribution`),
            });
          } else if (s >= RELATE_SIM_LOW && s <= RELATE_SIM_HIGH && !hasRelation) {
            // Same cluster required
            if (
              conceptA.cluster != null &&
              conceptB.cluster != null &&
              conceptA.cluster === conceptB.cluster
            ) {
              const filesA = getConceptFiles(db, conceptA);
              const filesB = getConceptFiles(db, conceptB);
              suggestions.push({
                kind: "relate",
                priority: RELATE_PRIORITY,
                confidence: s,
                title: `${conceptA.name} ↔ ${conceptB.name} — similarity ${s.toFixed(2)}, same cluster, no curated relation`,
                rationale:
                  "Similar concepts in the same cluster with no existing curated relation.",
                steps: [
                  {
                    tool: "show",
                    args: { concept: conceptA.name },
                    note: filesA.length > 0 ? `source files: ${filesA.join(", ")}` : undefined,
                  },
                  {
                    tool: "show",
                    args: { concept: conceptB.name },
                    note: filesB.length > 0 ? `source files: ${filesB.join(", ")}` : undefined,
                  },
                  {
                    tool: "relate",
                    args: { from: conceptA.name, to: conceptB.name },
                    note: "Infer the relation type from your analysis of the content above. Available types: depends_on, constrains, implements, uses, related_to",
                  },
                ],
                concepts: [conceptA.name, conceptB.name],
                evidence: {
                  cosine_similarity: s,
                  cluster: conceptA.cluster,
                  existing_relations: 0,
                },
                impact: { ...ZERO_IMPACT, rationale: "Improves graph connectivity (raises Fiedler value over time)" },
              });
            }
          }
        }
      }
    }
  }

  // ── 5. High ground_residual (review) ────────────────────
  // Uses ground_residual (concept vs source accuracy) directly, not the weighted formula.
  // Falls back to churn when ground_residual is not yet populated.
  const highResidual = activeConcepts
    .filter((c) => (c.ground_residual ?? c.churn ?? 0) > REVIEW_RESIDUAL_THRESHOLD)
    .sort((a, b) => (b.ground_residual ?? b.churn ?? 0) - (a.ground_residual ?? a.churn ?? 0))
    .slice(0, REVIEW_TOP_N);

  for (const concept of highResidual) {
    const r = concept.ground_residual ?? concept.churn ?? 0;
    const slug = toSlug(concept.name);
    const reviewNarrative = `review-${slug}`;

    suggestions.push({
      kind: "review",
      priority: REVIEW_PRIORITY,
      confidence: r,
      title: `${concept.name} — pressure ${r.toFixed(2)}, content has drifted from source files`,
      rationale:
        "High ground/lore residual indicates the concept content has drifted from the codebase.",
      steps: [
        {
          tool: "open",
          args: {
            narrative: reviewNarrative,
            intent: `Review high-pressure concept ${concept.name} (pressure: ${r.toFixed(2)})`,
          },
        },
        { tool: "show", args: { concept: concept.name } },
        {
          tool: "write",
          args: { narrative: reviewNarrative, entry: "…", topics: [concept.name] },
          note: "Document your findings",
        },
        { tool: "close", args: { narrative: reviewNarrative } },
      ],
      concepts: [concept.name],
      evidence: {
        ground_residual: concept.ground_residual,
        lore_residual: concept.lore_residual,
        churn: concept.churn,
        staleness: concept.staleness,
      },
      impact: impactForConcept(concept, 0.5, "Review typically halves concept pressure"),
    });
  }

  // ── 6. Cluster-drift outliers (self-healing) ────────────
  // Concepts with high lore_residual but low ground_residual are cluster topology
  // outliers — their content is accurate relative to source (ground is low) but
  // their embedding doesn't align well with cluster peers (lore is high). This
  // typically resolves naturally over subsequent delta closes as discoverConcepts
  // re-equilibrates the cluster topology with updated embeddings.
  const CLUSTER_DRIFT_LORE_THRESHOLD = 0.55;
  const CLUSTER_DRIFT_GROUND_MAX = 0.35;

  const clusterDrift = activeConcepts
    .filter((c) => {
      const gr = c.ground_residual ?? c.churn ?? 0;
      const hr = c.lore_residual ?? 0;
      // Must have a meaningful lore_residual signal (not null/zero from singleton clusters)
      if (c.lore_residual == null) return false;
      return hr > CLUSTER_DRIFT_LORE_THRESHOLD && gr < CLUSTER_DRIFT_GROUND_MAX;
    })
    .sort((a, b) => (b.lore_residual ?? 0) - (a.lore_residual ?? 0))
    .slice(0, 5);

  for (const concept of clusterDrift) {
    const hr = concept.lore_residual ?? 0;
    const gr = concept.ground_residual ?? concept.churn ?? 0;

    suggestions.push({
      kind: "cluster-drift",
      priority: CLUSTER_DRIFT_PRIORITY,
      confidence: hr,
      title: `${concept.name} — cluster outlier (lore ${(hr * 100).toFixed(0)}%, ground ${(gr * 100).toFixed(0)}%)`,
      rationale:
        "High lore_residual with low ground_residual: this concept's source accuracy is fine but it embeds differently from its cluster peers. This is a topology perturbation — common after large coordinated changes to many concepts. It self-heals as normal delta activity re-equilibrates the cluster over time. No immediate action required.",
      steps: [],
      concepts: [concept.name],
      evidence: {
        ground_residual: concept.ground_residual,
        lore_residual: concept.lore_residual,
        self_healing: true,
      },
      impact: { ...ZERO_IMPACT, rationale: "Self-healing; resolves with normal delta activity" },
    });
  }

  // ── 7. Isolated concepts (archive) ─────────────────────
  const edges = getEdges(db);
  const conceptsWithEdges = new Set<string>();
  for (const edge of edges) {
    conceptsWithEdges.add(edge.from_id);
    conceptsWithEdges.add(edge.to_id);
  }

  const conceptsWithRelations = new Set<string>();
  for (const rel of allRelations) {
    conceptsWithRelations.add(rel.from_concept_id);
    conceptsWithRelations.add(rel.to_concept_id);
  }

  for (const concept of activeConcepts) {
    const hasEdges = conceptsWithEdges.has(concept.id);
    const hasRelations = conceptsWithRelations.has(concept.id);
    const staleness = concept.staleness ?? 0;

    if (!hasEdges && !hasRelations && staleness > ARCHIVE_STALENESS_THRESHOLD) {
      suggestions.push({
        kind: "archive",
        priority: ARCHIVE_PRIORITY,
        confidence: staleness,
        title: `${concept.name} — no edges, no relations, staleness ${staleness.toFixed(2)}`,
        rationale: "Isolated concept with high staleness; likely no longer relevant.",
        steps: [{ tool: "archive", args: { concept: concept.name } }],
        concepts: [concept.name],
        evidence: { edges: 0, active_relations: 0, staleness },
        impact: impactForConcept(concept, 1.0, "Archiving removes concept and its full debt contribution"),
      });
    }
  }

  // ── Filter, sort, and slice ─────────────────────────────
  const filtered = kindFilter
    ? suggestions.filter((s) => kindFilter.includes(s.kind))
    : suggestions;

  filtered.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.confidence - a.confidence;
  });

  const topDebtReducers = filtered
    .filter((s) => (s.impact?.expected_debt_reduction_points ?? s.impact?.expected_debt_reduction ?? 0) > 0)
    .sort((a, b) => {
      const impactDelta =
        (b.impact?.expected_debt_reduction_points ?? b.impact?.expected_debt_reduction ?? 0)
        - (a.impact?.expected_debt_reduction_points ?? a.impact?.expected_debt_reduction ?? 0);
      if (Math.abs(impactDelta) > 1e-9) return impactDelta;
      if (a.priority !== b.priority) return a.priority - b.priority;
      return b.confidence - a.confidence;
    })
    .slice(0, 3)
    .map((s) => ({
      kind: s.kind,
      title: s.title,
      expected_debt_reduction: s.impact?.expected_debt_reduction ?? 0,
      expected_debt_reduction_points: s.impact?.expected_debt_reduction_points,
      expected_raw_debt_reduction: s.impact?.expected_raw_debt_reduction,
      percentage_of_total: s.impact?.percentage_of_total ?? 0,
    }));

  const topReducerReduction = topDebtReducers.reduce(
    (sum, item) => sum + (item.expected_debt_reduction_points ?? item.expected_debt_reduction),
    0,
  );
  const projectedDebtAfterTopReducers = totalDebt > 0
    ? Math.max(0, totalDebt - topReducerReduction)
    : null;

  const sliced = filtered.slice(0, limit);

  const cumulativeReduction = sliced.reduce(
    (sum, s) => sum + (s.impact?.expected_debt_reduction_points ?? s.impact?.expected_debt_reduction ?? 0),
    0,
  );
  const cumulativeRawReduction = sliced.reduce(
    (sum, s) => sum + (s.impact?.expected_raw_debt_reduction ?? 0),
    0,
  );
  const projectedDebtAfter = totalDebt > 0
    ? Math.max(0, totalDebt - cumulativeReduction)
    : null;
  const projectedRawDebtAfter = rawDebt > 0
    ? Math.max(0, rawDebt - cumulativeRawReduction)
    : null;

  return {
    suggestions: sliced,
    meta: {
      computed_at: new Date().toISOString(),
      concept_count: activeConcepts.length,
      total_debt: totalDebt,
      total_raw_debt: rawDebt,
      fiedler_value: laplacian?.fiedler_value ?? manifest?.fiedler_value ?? null,
      pairwise_computed: pairwiseComputed,
      projected_debt_after: projectedDebtAfter,
      projected_raw_debt_after: projectedRawDebtAfter,
      top_debt_reducers: topDebtReducers,
      projected_debt_after_top_reducers: projectedDebtAfterTopReducers,
    },
  };
}
