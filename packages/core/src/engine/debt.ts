import type { Database } from "bun:sqlite";
import type { ConceptRow, ManifestRow, RegistryEntry, SymbolDriftResult } from "@/types/index.ts";
import { getDriftedBindings } from "@/db/concept-symbols.ts";
import {
  computeExpectedDebt,
  computeSigmaByConcept,
  getBindingCoverageByConcept,
  type ConceptBindingCoverage,
  type GroundednessResult,
} from "./measurement.ts";

/**
 * One read-time view of the measurement axes (knowledge-model spec §3–4) for a
 * set of concepts. Every consumer — status priorities, ls, suggest, concept
 * health, ask warnings — reads R(c), σ(c) and p(c) from here rather than from
 * persisted columns, so no path can disagree with debt about a concept.
 */
export interface DebtSnapshot {
  debt: number;
  debt_trend: string;
  persisted_debt: number;
  live_debt: number;
  refWarnings: Map<string, string[]>;
  /** e_drift ratio per concept — only concepts with drift > 0 are present. */
  refDriftScoreByConcept: Map<string, number>;
  /** R(c) per concept: the only per-concept debt (§3.1). */
  residualByConcept: Map<string, GroundednessResult>;
  /** σ(c) per concept (§3.2). */
  sigmaByConcept: Map<string, number>;
  /** p(c) per concept — the consult share that weights R(c) into debt (§4.2). */
  consultShareByConcept: Map<string, number>;
  symbolDriftWarnings: Map<string, SymbolDriftResult[]>;
  /** Bindings per concept, and how many arrived after the prose was written. */
  bindingCoverageByConcept: Map<string, ConceptBindingCoverage>;
  ungroundedCount: number;
  /** Bound concepts whose e_embed was never computed — R(c) rests on drift alone. */
  unmeasuredEmbedCount: number;
}

/** R(c) for a concept in the snapshot; falls back to stored e_embed for strangers. */
export function conceptPressure(
  concept: ConceptRow,
  snapshot: Pick<DebtSnapshot, "residualByConcept">,
): number {
  return snapshot.residualByConcept.get(concept.id)?.residual ?? concept.ground_residual ?? 0;
}

/** σ(c) for a concept in the snapshot. Never the persisted `staleness` column. */
export function conceptLiveStaleness(
  concept: ConceptRow,
  snapshot: Pick<DebtSnapshot, "sigmaByConcept">,
): number {
  return snapshot.sigmaByConcept.get(concept.id) ?? 0;
}

/** Expected debt reduction from fully healing a concept: p(c) · R(c) · fraction. */
export function conceptDebtShare(
  concept: ConceptRow,
  snapshot: Pick<DebtSnapshot, "residualByConcept" | "consultShareByConcept">,
  fraction = 1,
): number {
  const p = snapshot.consultShareByConcept.get(concept.id) ?? 0;
  return p * conceptPressure(concept, snapshot) * fraction;
}

export async function computeDebtSnapshot(
  _entry: RegistryEntry,
  db: Database,
  concepts: ConceptRow[],
  manifest: ManifestRow | null,
  opts: { stalenessDays: number; now?: Date },
): Promise<DebtSnapshot> {
  const now = opts.now ?? new Date();
  // Expected consulted error: debt = Σ p(c)·R(c) ∈ [0,1], recomputed at read
  // time from the axes (knowledge-model spec §4.2). manifest.debt is a cache
  // of the last computed value, never a competing source — the old
  // max(persisted, live) rule let a stale cache pin debt high forever.
  const expected = computeExpectedDebt(db, concepts, now);
  const sigmaByConcept = computeSigmaByConcept(db, concepts, opts.stalenessDays, now);

  // Drifted-binding details, kept for warnings; the per-concept score is the
  // drift RATIO from the same computation that feeds debt (one signal, one
  // term — the 0.5/0.7/0.85/1.0 count steps scored 1 drifted of 40 bindings
  // like 1 of 2).
  const symbolDriftWarnings = new Map<string, SymbolDriftResult[]>();
  try {
    for (const drift of getDriftedBindings(db)) {
      const existing = symbolDriftWarnings.get(drift.concept_id);
      if (existing) existing.push(drift);
      else symbolDriftWarnings.set(drift.concept_id, [drift]);
    }
  } catch {
    // Table may not exist yet (pre-migration) — silently skip
  }
  let bindingCoverageByConcept = new Map<string, ConceptBindingCoverage>();
  try {
    bindingCoverageByConcept = getBindingCoverageByConcept(db);
  } catch {
    // Table may not exist yet (pre-migration) — silently skip
  }

  const refDriftScoreByConcept = new Map<string, number>();
  for (const [conceptId, g] of expected.residuals) {
    if (g.eDrift > 0) refDriftScoreByConcept.set(conceptId, g.eDrift);
  }

  const debt = expected.debt ?? 0;
  return {
    debt,
    debt_trend: manifest?.debt_trend ?? "stable",
    persisted_debt: manifest?.debt ?? debt,
    live_debt: debt,
    refWarnings: new Map(),
    refDriftScoreByConcept,
    residualByConcept: expected.residuals,
    sigmaByConcept,
    consultShareByConcept: expected.consultShare,
    symbolDriftWarnings,
    bindingCoverageByConcept,
    ungroundedCount: expected.ungroundedCount,
    unmeasuredEmbedCount: expected.unmeasuredEmbedCount,
  };
}

export interface ConceptPriorityAdvice {
  reason: string;
  action: string;
}

/**
 * Why one concept sits on the priority list, and what to do about it.
 *
 * A binding added after the prose raises e_embed on its own: the prose was
 * never written against that symbol. That is a coverage gap, and it is fixed
 * with prose or a split. Stale prose is fixed with a rewrite. The old line
 * reported both as "prose diverges from bound code", so an operator who
 * followed the tool's own advice to bind saw the metric punish the action.
 */
export function describeConceptPriority(input: {
  groundedness: GroundednessResult | undefined;
  sigma: number;
  driftedCount: number;
  coverage: ConceptBindingCoverage | undefined;
}): ConceptPriorityAdvice {
  const g = input.groundedness;
  if (!g || g.ungrounded) {
    return {
      reason: `No symbol bindings — the prose cannot be verified against code (σ ${(input.sigma * 100).toFixed(0)}%)`,
      action: "bind to code",
    };
  }
  if (input.driftedCount > 0) {
    return {
      reason: `${input.driftedCount} bound symbol(s) changed since verification (drift ${(g.eDrift * 100).toFixed(0)}%)`,
      action: "update — bound code changed",
    };
  }
  if (!g.eEmbedMeasured) {
    return {
      reason: "Bound, but the code-vs-prose residual was never measured",
      action: g.residual > 0.5 ? "update docs" : "review",
    };
  }
  const addedAfterProse = input.coverage?.addedAfterProse ?? 0;
  if (addedAfterProse > 0) {
    const total = input.coverage?.total ?? addedAfterProse;
    return {
      reason: `Prose predates ${addedAfterProse} of ${total} binding(s) — it never described that code (embedding residual ${(g.eEmbed * 100).toFixed(0)}%)`,
      action: "cover the new bindings, or split the concept",
    };
  }
  return {
    reason: `Prose diverges from bound code (embedding residual ${(g.eEmbed * 100).toFixed(0)}%)`,
    action: g.residual > 0.5 ? "update docs" : "review",
  };
}
