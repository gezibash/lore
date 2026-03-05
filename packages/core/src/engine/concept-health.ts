import type {
  ConceptHealthNeighbor,
  ConceptHealthTopRow,
  ConceptRelationRow,
  ConceptRow,
} from "@/types/index.ts";
import { computeTotalDebt, conceptPressureBase } from "./residuals.ts";

export interface ComputedConceptHealthSignal {
  concept_id: string;
  concept: string;
  time_stale: number;
  ref_stale: number;
  local_graph_stale: number;
  global_shock: number;
  influence: number;
  critical_multiplier: number;
  final_stale: number;
  residual_after_adjust: number;
  debt_after_adjust: number;
}

export interface ComputeConceptHealthSignalsInput {
  concepts: ConceptRow[];
  refDriftScoreByConcept: Map<string, number>;
  relations: ConceptRelationRow[];
  criticalConceptIds: Set<string>;
  fiedlerValue: number;
  baseDebt: number;
}

export interface ComputeConceptHealthSignalsResult {
  signals: ComputedConceptHealthSignal[];
  topStale: ConceptHealthTopRow[];
  debtAfterAdjust: number;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function conceptBaseStale(
  concept: ConceptRow,
  refDriftScoreByConcept: Map<string, number>,
): number {
  const time = clamp(concept.staleness ?? 0);
  const ref = clamp(refDriftScoreByConcept.get(concept.id) ?? 0);
  return clamp(0.6 * time + 0.4 * ref);
}

function relationWeight(relation: ConceptRelationRow): number {
  return clamp(relation.weight <= 0 ? 0 : relation.weight);
}

function computeGlobalShock(
  concepts: ConceptRow[],
  refDriftScoreByConcept: Map<string, number>,
  baseDebt: number,
): number {
  if (concepts.length === 0) return 0;

  const baseStaleValues = concepts.map((concept) =>
    conceptBaseStale(concept, refDriftScoreByConcept),
  );
  const highStaleRatio =
    baseStaleValues.filter((value) => value >= 0.65).length / Math.max(1, baseStaleValues.length);
  const driftRatio =
    concepts.filter((concept) => (refDriftScoreByConcept.get(concept.id) ?? 0) > 0).length /
    Math.max(1, concepts.length);

  return clamp(0.5 * highStaleRatio + 0.25 * driftRatio + 0.25 * clamp(baseDebt));
}

export function computeConceptHealthSignals(
  input: ComputeConceptHealthSignalsInput,
): ComputeConceptHealthSignalsResult {
  const concepts = input.concepts;
  const conceptById = new Map(concepts.map((concept) => [concept.id, concept]));
  const refDriftScoreByConcept = input.refDriftScoreByConcept;
  const relations = input.relations.filter((relation) => relation.active === 1);
  const criticalConceptIds = input.criticalConceptIds;

  const baseStaleByConceptId = new Map<string, number>();
  for (const concept of concepts) {
    baseStaleByConceptId.set(concept.id, conceptBaseStale(concept, refDriftScoreByConcept));
  }

  const outbound = new Map<string, ConceptRelationRow[]>();
  const inbound = new Map<string, ConceptRelationRow[]>();
  for (const relation of relations) {
    if (!outbound.has(relation.from_concept_id)) outbound.set(relation.from_concept_id, []);
    if (!inbound.has(relation.to_concept_id)) inbound.set(relation.to_concept_id, []);
    outbound.get(relation.from_concept_id)!.push(relation);
    inbound.get(relation.to_concept_id)!.push(relation);
  }

  const globalShock = computeGlobalShock(concepts, refDriftScoreByConcept, input.baseDebt);

  const interimSignals: Array<
    Omit<ComputedConceptHealthSignal, "residual_after_adjust" | "debt_after_adjust">
  > = [];

  for (const concept of concepts) {
    const timeStale = clamp(concept.staleness ?? 0);
    const refStale = clamp(refDriftScoreByConcept.get(concept.id) ?? 0);

    const neighbors = (outbound.get(concept.id) ?? []).concat(inbound.get(concept.id) ?? []);
    let neighborWeightTotal = 0;
    let neighborSignalTotal = 0;
    for (const relation of neighbors) {
      const neighborId =
        relation.from_concept_id === concept.id ? relation.to_concept_id : relation.from_concept_id;
      if (!conceptById.has(neighborId)) continue;
      const w = relationWeight(relation);
      neighborWeightTotal += w;
      neighborSignalTotal += w * (baseStaleByConceptId.get(neighborId) ?? 0);
    }

    const localGraphStale =
      neighborWeightTotal > 0 ? clamp(neighborSignalTotal / neighborWeightTotal) : 0;

    const inboundWeight = (inbound.get(concept.id) ?? []).reduce(
      (sum, relation) => sum + relationWeight(relation),
      0,
    );
    const outboundWeight = (outbound.get(concept.id) ?? []).reduce(
      (sum, relation) => sum + relationWeight(relation),
      0,
    );
    const influenceRaw = 0.7 * inboundWeight + 0.3 * outboundWeight;
    const influence = clamp(influenceRaw / 3);

    const criticalMultiplier = criticalConceptIds.has(concept.id) ? 1.35 : 1;

    const finalRaw =
      0.35 * timeStale +
      0.3 * refStale +
      0.2 * localGraphStale +
      0.1 * globalShock +
      0.05 * influence;
    const finalStale = clamp(finalRaw * criticalMultiplier);

    interimSignals.push({
      concept_id: concept.id,
      concept: concept.name,
      time_stale: timeStale,
      ref_stale: refStale,
      local_graph_stale: localGraphStale,
      global_shock: globalShock,
      influence,
      critical_multiplier: criticalMultiplier,
      final_stale: finalStale,
    });
  }

  const adjustedConcepts: ConceptRow[] = concepts.map((concept) => {
    const signal = interimSignals.find((item) => item.concept_id === concept.id);
    const finalStale = signal?.final_stale ?? 0;
    const adjustedResidual = clamp(Math.max(conceptPressureBase(concept), finalStale * 0.9));

    // Override ground_residual so computeTotalDebt (which uses conceptPressureBase) sees the adjusted value
    return {
      ...concept,
      ground_residual: adjustedResidual,
      lore_residual: 0,
      staleness: finalStale,
    };
  });

  const debtAfterAdjust = computeTotalDebt(adjustedConcepts, input.fiedlerValue);

  const signals: ComputedConceptHealthSignal[] = interimSignals
    .map((signal) => {
      const concept = conceptById.get(signal.concept_id);
      const residualAfterAdjust = clamp(
        Math.max(
          concept ? conceptPressureBase(concept) : 0,
          signal.final_stale * signal.critical_multiplier * 0.75,
        ),
      );
      return {
        ...signal,
        residual_after_adjust: residualAfterAdjust,
        debt_after_adjust: debtAfterAdjust,
      };
    })
    .sort((a, b) => b.final_stale - a.final_stale || a.concept.localeCompare(b.concept));

  const topStale: ConceptHealthTopRow[] = signals.slice(0, 5).map((signal) => ({
    concept: signal.concept,
    final_stale: signal.final_stale,
    time_stale: signal.time_stale,
    ref_stale: signal.ref_stale,
    local_graph_stale: signal.local_graph_stale,
    global_shock: signal.global_shock,
    influence: signal.influence,
    critical: signal.critical_multiplier > 1,
  }));

  return {
    signals,
    topStale,
    debtAfterAdjust,
  };
}

export function buildConceptHealthNeighbors(
  conceptId: string,
  relations: ConceptRelationRow[],
  conceptsById: Map<string, ConceptRow>,
  finalStaleByConceptId: Map<string, number>,
): ConceptHealthNeighbor[] {
  const neighbors: ConceptHealthNeighbor[] = [];

  for (const relation of relations) {
    if (relation.active !== 1) continue;

    if (relation.from_concept_id === conceptId) {
      const to = conceptsById.get(relation.to_concept_id);
      if (!to) continue;
      neighbors.push({
        concept: to.name,
        relation_type: relation.relation_type,
        direction: "outbound",
        weight: relation.weight,
        neighbor_final_stale: finalStaleByConceptId.get(to.id) ?? null,
      });
      continue;
    }

    if (relation.to_concept_id === conceptId) {
      const from = conceptsById.get(relation.from_concept_id);
      if (!from) continue;
      neighbors.push({
        concept: from.name,
        relation_type: relation.relation_type,
        direction: "inbound",
        weight: relation.weight,
        neighbor_final_stale: finalStaleByConceptId.get(from.id) ?? null,
      });
    }
  }

  return neighbors.sort((a, b) => {
    if (b.weight !== a.weight) return b.weight - a.weight;
    return a.concept.localeCompare(b.concept);
  });
}

export interface HealSignalInput {
  concept: ConceptRow;
  finalStale: number;
}

export function healSignal(input: HealSignalInput): {
  from_staleness: number;
  to_staleness: number;
  from_residual: number;
  to_residual: number;
} {
  const fromStaleness = clamp(input.concept.staleness ?? 0);
  // Use residual (backward-compat field) to show the before/after heal delta
  const fromResidual = clamp(input.concept.residual ?? 0);
  const pressure = clamp(input.finalStale);

  const toStaleness = clamp(Math.max(0, fromStaleness - (0.2 + pressure * 0.3)));
  const toResidual = clamp(Math.max(0, fromResidual - (0.12 + pressure * 0.25)));

  return {
    from_staleness: fromStaleness,
    to_staleness: toStaleness,
    from_residual: fromResidual,
    to_residual: toResidual,
  };
}
