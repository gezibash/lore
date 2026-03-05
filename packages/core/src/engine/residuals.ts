import type { Database } from "bun:sqlite";
import type { LoreConfig, ConceptRow } from "@/types/index.ts";
import { insertResidualHistory } from "@/db/residuals.ts";
import { getFileCoverage } from "@/db/concept-symbols.ts";

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

const GROUND_WEIGHT = 0.6;
const LORE_WEIGHT = 0.4;

/**
 * Compute the accuracy pressure for a single concept.
 * Driven by ground_residual (concept vs source) and lore_residual (concept vs cluster peers).
 * Falls back to churn when ground_residual is not yet populated.
 */
export function conceptPressureBase(concept: ConceptRow): number {
  const gr = concept.ground_residual ?? concept.churn ?? 0;
  const hr = concept.lore_residual ?? 0;
  return GROUND_WEIGHT * gr + LORE_WEIGHT * hr;
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
 * Total debt = sum(pressure) / (1 + fiedler_value).
 * Pressure is driven by ground_residual and lore_residual, not churn.
 * High Fiedler (connected graph) → divisor grows → debt shrinks.
 * Low Fiedler (scattered) → divisor ≈ 1 → raw pressure sum.
 * Fiedler = 0 (disconnected) → debt unchanged.
 */
export function computeTotalDebt(concepts: ConceptRow[], fiedlerValue: number = 0): number {
  const rawDebt = concepts.reduce((sum, c) => sum + conceptPressureBase(c), 0);
  return rawDebt / (1 + fiedlerValue);
}

/**
 * Per-component debt: sum each cluster's raw pressure divided by its own Fiedler value.
 * Prevents a well-connected cluster from discounting debt in isolated clusters.
 * Each component provides its own concepts and local Fiedler connectivity measure.
 */
export function computeComponentDebt(
  components: Array<{ concepts: ConceptRow[]; fiedlerValue: number }>,
): number {
  return components.reduce((total, comp) => {
    const rawDebt = comp.concepts.reduce((sum, c) => sum + conceptPressureBase(c), 0);
    return total + rawDebt / (1 + comp.fiedlerValue);
  }, 0);
}

/**
 * Determine debt trend based on recent residual history.
 */
export function computeDebtTrend(
  currentDebt: number,
  previousDebt: number,
): "improving" | "stable" | "degrading" {
  const delta = currentDebt - previousDebt;
  if (delta < -0.5) return "improving";
  if (delta > 0.5) return "degrading";
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
  if (concepts.length === 0) return 1.0;

  const fileCoverage = getFileCoverage(db);

  // Build per-concept bound-symbol counts from file coverage aggregation.
  // We use a per-concept aggregation query-free approach: sum file bound_count
  // for files bound to each concept. Since getFileCoverage is file-level,
  // build a concept→files lookup via concept ground_residual and symbol counts.
  // Simpler: use per-concept ground_residual weighted by their share of total symbols.

  // Total symbols across all files (denominator baseline)
  const totalSymbols = fileCoverage.reduce((s, f) => s + f.symbol_count, 0);
  if (totalSymbols === 0) return concepts.length > 0 ? 0 : 1.0;

  // Covered symbols (at least one concept binding)
  const coveredSymbols = fileCoverage.reduce((s, f) => s + f.bound_count, 0);

  // Weighted sum over concepts using ground_residual and bound_count approximation.
  // Weight each concept by: coveredSymbols / totalSymbols (shared weight).
  // Plus uncovered fraction contributes residual=1.0.
  let weightedResidualSum = 0;
  let totalWeight = 0;

  for (const concept of concepts) {
    const gr = concept.ground_residual ?? 0;
    // Weight = concept's share of covered symbols (proxy: equal share of coveredSymbols)
    // Better: each concept gets weight proportional to bound_count / totalSymbols.
    // We don't have per-concept bound_count here cheaply, so use equal share.
    const w = coveredSymbols / totalSymbols / concepts.length;
    weightedResidualSum += gr * w;
    totalWeight += w;
  }

  // Uncovered fraction contributes residual=1.0
  const uncoveredFraction = Math.max(0, 1 - coveredSymbols / totalSymbols);
  weightedResidualSum += 1.0 * uncoveredFraction;
  totalWeight += uncoveredFraction;

  if (totalWeight <= 0) return 0;
  return Math.min(1, weightedResidualSum / totalWeight);
}

/**
 * Record residuals for all concepts.
 */
export function recordResiduals(
  db: Database,
  concepts: ConceptRow[],
  fiedlerValue: number = 0,
): void {
  const totalDebt = computeTotalDebt(concepts, fiedlerValue);
  for (const concept of concepts) {
    if (concept.residual != null) {
      insertResidualHistory(db, concept.id, concept.residual, totalDebt);
    }
  }
}
