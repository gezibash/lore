import type { Database } from "bun:sqlite";
import type { ConceptRow, ManifestRow, RegistryEntry, SymbolDriftResult } from "@/types/index.ts";
import { getDriftedBindings } from "@/db/concept-symbols.ts";
import { computeTotalDebt, conceptPressureBase } from "./residuals.ts";

const SYMBOL_DRIFT_RESIDUAL_WEIGHT = 0.85;

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
  // Base pressure from ground_residual + lore_residual (falls back to churn if not yet computed)
  const base = conceptPressureBase(concept);
  const symbolDriftPressure =
    (refDriftScoreByConcept.get(concept.id) ?? 0) * SYMBOL_DRIFT_RESIDUAL_WEIGHT;
  return Math.max(base, conceptLiveStaleness(concept, refDriftScoreByConcept), symbolDriftPressure);
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
  const fiedlerValue = manifest?.fiedler_value ?? 0;
  const persistedDebt = manifest?.debt ?? computeTotalDebt(concepts, fiedlerValue);

  // Compute symbol drift scores (replaces legacy ref drift)
  const symbolDriftScoreByConcept = new Map<string, number>();
  const symbolDriftWarnings = new Map<string, SymbolDriftResult[]>();
  try {
    const driftedBindings = getDriftedBindings(db);
    for (const drift of driftedBindings) {
      const existing = symbolDriftWarnings.get(drift.concept_id);
      if (existing) {
        existing.push(drift);
      } else {
        symbolDriftWarnings.set(drift.concept_id, [drift]);
      }
    }
    // Score: based on fraction of drifted bindings. More drifted = higher score.
    for (const [conceptId, drifts] of symbolDriftWarnings) {
      // Normalize: 1 drift = 0.5, 2 = 0.7, 3+ = 0.85, 5+ = 1.0
      const count = drifts.length;
      let score: number;
      if (count >= 5) score = 1.0;
      else if (count >= 3) score = 0.85;
      else if (count >= 2) score = 0.7;
      else score = 0.5;
      symbolDriftScoreByConcept.set(conceptId, score);
    }
  } catch {
    // Table may not exist yet (pre-migration) — silently skip
  }

  // Use symbol drift as the single drift signal (replaces legacy ref drift)
  const refDriftScoreByConcept = symbolDriftScoreByConcept;
  const refWarnings = new Map<string, string[]>();

  // Compute live debt: sum of full pressure (including symbol drift) / (1 + fiedler)
  const rawLiveDebt = concepts.reduce(
    (sum, c) => sum + conceptPressure(c, refDriftScoreByConcept),
    0,
  );
  const liveDebt = rawLiveDebt / (1 + fiedlerValue);
  const debt = Math.max(persistedDebt, liveDebt);
  const debtTrendBase = manifest?.debt_trend ?? "stable";
  const driftNote = symbolDriftScoreByConcept.size > 0 ? ", live symbol drift" : "";
  const debt_trend = debt > persistedDebt + 1e-9 ? `${debtTrendBase}${driftNote}` : debtTrendBase;

  return {
    debt,
    debt_trend,
    persisted_debt: persistedDebt,
    live_debt: liveDebt,
    refWarnings,
    refDriftScoreByConcept,
    symbolDriftWarnings,
  };
}
