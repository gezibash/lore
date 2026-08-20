import type { Database } from "bun:sqlite";
import type { LoreConfig, ConceptRow } from "@/types/index.ts";
import { insertResidualHistory } from "@/db/residuals.ts";
import { computeStateDistanceSpec } from "./measurement.ts";

/**
 * Compute residual for a concept as version-to-version drift.
 * Residual = cosine distance between the concept's current chunk embedding
 * and its previous chunk embedding. If no previous version exists, residual = 0.
 */
export function computeResidual(
  currentEmbedding: Float32Array,
  previousEmbedding: Float32Array | null,
): number {
  if (!previousEmbedding) return 0;
  return cosineDistance(currentEmbedding, previousEmbedding);
}

export function cosineDistance(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 1;
  return 1 - dot / denom;
}

/**
 * Compute staleness for a concept based on time since last update.
 * Returns 0-1 where 1 means fully stale (beyond staleness_days threshold).
 */
export function computeStaleness(lastUpdated: string, config: LoreConfig): number {
  const age = Date.now() - new Date(lastUpdated).getTime();
  const ageDays = age / (24 * 60 * 60 * 1000);
  return Math.min(1, ageDays / config.thresholds.staleness_days);
}

/**
 * e_embed: the concept-vs-bound-code embedding residual, falling back to churn
 * when not yet populated. lore_residual (cluster cohesion) is a graph
 * property, not error evidence — as pressure it punished semantic
 * distinctiveness with a penalty no maintenance action could heal.
 */
export function conceptPressureBase(concept: ConceptRow): number {
  return concept.ground_residual ?? concept.churn ?? 0;
}

/**
 * Average a list of Float32Array vectors component-wise.
 */
export function averageVectors(vecs: Float32Array[]): Float32Array {
  if (vecs.length === 0) throw new Error("Cannot average empty vector list");
  const dim = vecs[0]!.length;
  const result = new Float32Array(dim);
  for (const v of vecs) {
    for (let i = 0; i < dim; i++) {
      result[i] = result[i]! + v[i]!;
    }
  }
  for (let i = 0; i < dim; i++) {
    result[i] = result[i]! / vecs.length;
  }
  return result;
}

/**
 * Confidence-weighted average of Float32Array vectors.
 * Vectors with higher weights contribute more to the result.
 * Falls back to uniform average when all weights are zero.
 */
export function weightedAverageVectors(vecs: Float32Array[], weights: number[]): Float32Array {
  if (vecs.length === 0) throw new Error("Cannot average empty vector list");
  const dim = vecs[0]!.length;
  const result = new Float32Array(dim);
  let totalWeight = 0;
  for (let i = 0; i < vecs.length; i++) {
    const w = weights[i] ?? 0;
    totalWeight += w;
    const v = vecs[i]!;
    for (let j = 0; j < dim; j++) {
      result[j] = result[j]! + v[j]! * w;
    }
  }
  if (totalWeight === 0) {
    // Degenerate case: fall back to uniform average
    return averageVectors(vecs);
  }
  for (let i = 0; i < dim; i++) {
    result[i] = result[i]! / totalWeight;
  }
  return result;
}

/**
 * Determine debt trend from relative change (knowledge-model spec §8): the old
 * ±0.5 absolute delta was meaningless once debt became a [0,1] expectation.
 */
export function computeDebtTrend(
  currentDebt: number,
  previousDebt: number,
): "improving" | "stable" | "degrading" {
  if (previousDebt <= 0) return currentDebt > 0 ? "degrading" : "stable";
  const relative = (currentDebt - previousDebt) / previousDebt;
  if (relative < -0.1) return "improving";
  if (relative > 0.1) return "degrading";
  return "stable";
}

/**
 * Compute formal state distance S_dist(lore, codebase) ∈ [0,1].
 *
 * Geometric distance between the lore state and the codebase state:
 *   S_dist = Σ_i (ground_residual_i × w_i) / Σ_i w_i
 * where w_i = bound_symbol_count_i / total_symbols_in_bound_files_i
 *
 * Concepts with no bound symbols get w=0 (excluded from the weighted sum).
 * Uncovered files (no concept bound to them) contribute residual=1.0 with
 * weight proportional to their symbol count — capturing dark zones.
 *
 * Unlike debt (a maintenance score), state distance is an epistemological gap.
 */
export function computeStateDistance(db: Database, concepts: ConceptRow[]): number {
  // Real per-concept bound-symbol masses, ungrounded concepts included at
  // residual 1 with floor mass ε — the equal-share/exclude-ungrounded
  // shortcut this replaces contradicted the formula above.
  return computeStateDistanceSpec(db, concepts);
}

/**
 * Record residuals for all concepts alongside the current total debt value.
 */
export function recordResiduals(db: Database, concepts: ConceptRow[], totalDebt: number): void {
  for (const concept of concepts) {
    if (concept.residual != null) {
      insertResidualHistory(db, concept.id, concept.residual, totalDebt);
    }
  }
}
