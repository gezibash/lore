import type { Database } from "bun:sqlite";
import type { ConceptRow, LoreConfig } from "@/types/index.ts";
import { getChunk, getConcept, getEmbeddingForChunk, getFilesForConcept } from "@/db/index.ts";
import { insertConceptVersion } from "@/db/concepts.ts";
import { getDriftedBindings, reverifyConceptSymbol } from "@/db/concept-symbols.ts";
import { readChunk, updateChunkFrontmatter } from "@/storage/index.ts";
import { mapConcurrent } from "./async.ts";
import { autoBindByFileOverlap, extractBindingsForConcepts } from "./binding-extraction.ts";
import type { Embedder } from "./embedder.ts";
import type { Generator } from "./generator.ts";
import { readSymbolContent } from "./git.ts";
import { measureGroundResiduals } from "./ground-residual.ts";
import {
  getConceptBindingStats,
  getVerifiedAtByConcept,
  groundednessResidual,
  stalenessSigma,
  type GroundednessResult,
} from "./measurement.ts";
import { rescanFiles } from "./scanner.ts";

/**
 * Heal (knowledge-model spec §7): an evidence-producing action on one concept.
 *
 * Heal never decides a concept is healthier — it goes and looks:
 *   1. rescan the concept's bound files so symbol body hashes are current;
 *   2. if the concept is ungrounded, extract bindings (purely additive — for a
 *      bound concept re-extraction would wipe and re-bind at current hashes,
 *      i.e. re-verify every drifted binding by decree, so it is never run);
 *   3. verify each drifted binding with the generator: does the prose still
 *      hold against the symbol's new body? yes → re-verify; no → stays
 *      drifted with the reason, which is the reader's cue to open a narrative;
 *   4. re-measure e_embed with the shared measurement;
 *   5. refresh the `residual` column (the R(c) cache) from the axes.
 *
 * Whatever R(c) and σ(c) come out is reported as-is — including a rise, when
 * measuring e_embed for the first time reveals prose that drifted from code.
 */

export interface HealConceptDeps {
  db: Database;
  config: LoreConfig;
  codePath: string | null;
  embedder: Embedder;
  codeEmbedder: Embedder | null;
  generator: Generator;
  now?: Date;
}

export interface HealConceptOutcome {
  concept: string;
  from_residual: number;
  to_residual: number;
  from_staleness: number;
  to_staleness: number;
  ungrounded_before: boolean;
  ungrounded_after: boolean;
  bindings_added: number;
  bindings_verified: number;
  bindings_still_drifted: number;
  /** e_embed after re-measurement; null when it could not be measured. */
  e_embed: number | null;
  /** One line per drifted binding the verifier rejected: "symbol: reason". */
  still_drifted_reasons: string[];
  rescan_failed: string[];
}

function axesFor(
  db: Database,
  concept: ConceptRow,
  stalenessDays: number,
  now: Date,
): { g: GroundednessResult; sigma: number } {
  const stats = getConceptBindingStats(db).get(concept.id);
  const verifiedAt = getVerifiedAtByConcept(db).get(concept.id);
  return {
    g: groundednessResidual(concept, stats),
    sigma: stalenessSigma(concept, stats, verifiedAt, stalenessDays, now),
  };
}

/** The plan heal would execute — what a dry run reports. No writes, no LLM. */
export function planHealConcept(
  db: Database,
  concept: ConceptRow,
  stalenessDays: number,
  now = new Date(),
): Pick<
  HealConceptOutcome,
  "concept" | "from_residual" | "from_staleness" | "ungrounded_before" | "bindings_still_drifted"
> & { e_embed_measured: boolean } {
  const { g, sigma } = axesFor(db, concept, stalenessDays, now);
  const drifted = getDriftedBindings(db).filter((d) => d.concept_id === concept.id).length;
  return {
    concept: concept.name,
    from_residual: g.residual,
    from_staleness: sigma,
    ungrounded_before: g.ungrounded,
    bindings_still_drifted: drifted,
    e_embed_measured: g.eEmbedMeasured,
  };
}

export async function healConcept(
  deps: HealConceptDeps,
  conceptId: string,
): Promise<HealConceptOutcome | null> {
  const { db, config, codePath } = deps;
  const now = deps.now ?? new Date();
  const stalenessDays = config.thresholds.staleness_days;
  const before = getConcept(db, conceptId);
  if (!before || !before.active_chunk_id) return null;
  const chunk = getChunk(db, before.active_chunk_id);
  if (!chunk) return null;
  const prose = (await readChunk(chunk.file_path)).content;

  const axesBefore = axesFor(db, before, stalenessDays, now);
  const statsBefore = getConceptBindingStats(db).get(conceptId);
  const boundBefore = statsBefore?.total ?? 0;

  let rescanFailed: string[] = [];
  let bindingsAdded = 0;
  let bindingsVerified = 0;
  const stillDriftedReasons: string[] = [];

  if (codePath) {
    // 1. Current hashes for everything this concept is bound to.
    const files = getFilesForConcept(db, conceptId);
    if (files.length > 0) {
      rescanFailed = (await rescanFiles(db, codePath, files)).filesFailed;
    }

    // 2. Ungrounded → look for bindings. Additive only; see module doc.
    if (boundBefore === 0) {
      await extractBindingsForConcepts(db, [conceptId]);
      await autoBindByFileOverlap(db, { conceptIds: [conceptId] });
      bindingsAdded = getConceptBindingStats(db).get(conceptId)?.total ?? 0;
    }

    // 3. Verify drifted bindings against the new code — the only way a
    //    binding gets re-verified without the prose being rewritten.
    const drifted = getDriftedBindings(db).filter((d) => d.concept_id === conceptId);
    await mapConcurrent(drifted, 4, async (binding) => {
      const newBody = await readSymbolContent(
        codePath,
        binding.file_path,
        binding.line_start,
        binding.line_end,
      );
      if (!newBody) {
        stillDriftedReasons.push(`${binding.symbol_qualified_name}: current body unreadable`);
        return;
      }
      const verdict = await deps.generator.verifyBindingStillAccurate({
        conceptName: before.name,
        prose,
        symbolName: binding.symbol_qualified_name,
        oldBody: binding.bound_body,
        newBody,
      });
      if (verdict.accurate) {
        reverifyConceptSymbol(db, {
          conceptId,
          symbolId: binding.symbol_id,
          bodyHash: binding.current_body_hash,
          body: newBody,
        });
        bindingsVerified++;
      } else {
        stillDriftedReasons.push(
          `${binding.symbol_qualified_name}: ${verdict.reason || "no reason given"}`,
        );
      }
    });
  }

  // 4. e_embed, re-measured against whatever is bound now.
  const textEmbeddingRow = getEmbeddingForChunk(db, before.active_chunk_id);
  const eEmbedByConcept = await measureGroundResiduals(db, {
    codePath,
    targets: [
      {
        conceptId,
        content: prose,
        textEmbedding: textEmbeddingRow
          ? new Float32Array(textEmbeddingRow.embedding.buffer)
          : null,
      },
    ],
    embedder: deps.embedder,
    codeEmbedder: deps.codeEmbedder,
    codeModel: config.ai.embedding.code?.model ?? null,
  });
  const eEmbed = eEmbedByConcept.get(conceptId) ?? null;
  if (eEmbed != null) {
    insertConceptVersion(db, conceptId, { ground_residual: eEmbed });
  }

  // 5. R(c) cache from the axes.
  const after = getConcept(db, conceptId) ?? before;
  const axesAfter = axesFor(db, after, stalenessDays, now);
  if (after.residual == null || Math.abs(after.residual - axesAfter.g.residual) > 1e-9) {
    insertConceptVersion(db, conceptId, { residual: axesAfter.g.residual });
  }
  try {
    await updateChunkFrontmatter(chunk.file_path, { fl_residual: axesAfter.g.residual });
  } catch {
    // Best-effort mirror; the DB row is authoritative.
  }

  const stillDrifted = getDriftedBindings(db).filter((d) => d.concept_id === conceptId).length;
  return {
    concept: before.name,
    from_residual: axesBefore.g.residual,
    to_residual: axesAfter.g.residual,
    from_staleness: axesBefore.sigma,
    to_staleness: axesAfter.sigma,
    ungrounded_before: axesBefore.g.ungrounded,
    ungrounded_after: axesAfter.g.ungrounded,
    bindings_added: bindingsAdded,
    bindings_verified: bindingsVerified,
    bindings_still_drifted: stillDrifted,
    e_embed: eEmbed,
    still_drifted_reasons: stillDriftedReasons,
    rescan_failed: rescanFailed,
  };
}
