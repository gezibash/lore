import type { Database } from "bun:sqlite";
import type { ConceptRow, ManifestRow, RegistryEntry, SymbolDriftResult } from "@/types/index.ts";
import { getDriftedBindings } from "@/db/concept-symbols.ts";
import { conceptPressureBase } from "./residuals.ts";
import { computeExpectedDebt } from "./measurement.ts";

export interface DebtSnapshot {
  debt: number;
  debt_trend: string;
  persisted_debt: number;
  live_debt: number;
  refWarnings: Map<string, string[]>;
  refDriftScoreByConcept: Map<string, number>;
  symbolDriftWarnings: Map<string, SymbolDriftResult[]>;
}

export function conceptPressure(
  concept: ConceptRow,
  refDriftScoreByConcept: Map<string, number>,
): number {
  // R(c) shape: max of evidence — embedding residual and the drift ratio.
  // (lore_residual and age-based staleness are no longer evidence: cluster
  // cohesion is a graph property, wall-clock age punishes stable code.)
  const base = conceptPressureBase(concept);
  return Math.max(base, refDriftScoreByConcept.get(concept.id) ?? 0);
}

export function conceptLiveStaleness(
  concept: ConceptRow,
  refDriftScoreByConcept: Map<string, number>,
): number {
  return Math.max(concept.staleness ?? 0, refDriftScoreByConcept.get(concept.id) ?? 0);
}

export async function computeDebtSnapshot(
  entry: RegistryEntry,
  db: Database,
  concepts: ConceptRow[],
  manifest: ManifestRow | null,
): Promise<DebtSnapshot> {
  // Expected consulted error: debt = Σ p(c)·R(c) ∈ [0,1], recomputed at read
  // time from the axes (knowledge-model spec §4.2). manifest.debt is a cache
  // of the last computed value, never a competing source — the old
  // max(persisted, live) rule let a stale cache pin debt high forever.
  const expected = computeExpectedDebt(db, concepts);

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
    symbolDriftWarnings,
  };
}
