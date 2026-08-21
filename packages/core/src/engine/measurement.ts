import type { Database } from "bun:sqlite";
import type { ConceptRow } from "@/types/index.ts";

/**
 * Measurement axes per docs/knowledge-model.md §3–4.
 *
 * Every stored signal measures exactly one latent quantity; composites are
 * derived at read time and never written back into the axes. Within one
 * quantity evidence combines by max (doubt is disjunctive); across concepts
 * composites are probability- or mass-weighted means (expected value).
 */

// ── §3.1 groundedness residual ───────────────────────────────────────────────

export interface ConceptBindingStats {
  total: number;
  drifted: number;
}

/** One query: total and drifted binding counts per concept. */
export function getConceptBindingStats(db: Database): Map<string, ConceptBindingStats> {
  const rows = db
    .query<{ concept_id: string; total: number; drifted: number }, []>(
      `SELECT cs.concept_id,
              COUNT(*) AS total,
              SUM(CASE WHEN cs.bound_body_hash IS NOT NULL
                        AND s.body_hash IS NOT NULL
                        AND cs.bound_body_hash != s.body_hash
                  THEN 1 ELSE 0 END) AS drifted
       FROM concept_symbols cs
       JOIN symbols s ON cs.symbol_id = s.id
       GROUP BY cs.concept_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.concept_id, { total: r.total, drifted: r.drifted }]));
}

export interface GroundednessResult {
  /** R(c) ∈ [0,1] */
  residual: number;
  /** Drifted / total bindings; 0 when unbound. */
  eDrift: number;
  /** Concept-vs-bound-code embedding distance (stored ground_residual). */
  eEmbed: number;
  /**
   * Whether e_embed was ever computed for this concept. When false, R(c)
   * rests on drift alone — that is a measurement gap, not a clean bill, and
   * callers must surface it rather than read the 0 as evidence.
   */
  eEmbedMeasured: boolean;
  /** B(c) = ∅ — an unverifiable claim; scored R = 1 in composites. */
  ungrounded: boolean;
}

/** R(c) = max(e_drift, e_embed); ungrounded concepts score 1. */
export function groundednessResidual(
  concept: ConceptRow,
  bindings: ConceptBindingStats | undefined,
): GroundednessResult {
  const total = bindings?.total ?? 0;
  const eEmbedMeasured = concept.ground_residual != null;
  const eEmbed = concept.ground_residual ?? 0;
  if (total === 0) {
    return { residual: 1, eDrift: 0, eEmbed, eEmbedMeasured, ungrounded: true };
  }
  const eDrift = (bindings?.drifted ?? 0) / total;
  return { residual: Math.max(eDrift, eEmbed), eDrift, eEmbed, eEmbedMeasured, ungrounded: false };
}

// ── §3.2 staleness σ(c) ──────────────────────────────────────────────────────

/**
 * One query: when each concept was last verified — the created_at of its
 * active state chunk (the last time the prose was actually rewritten). The
 * concept row's own inserted_at is NOT that: every metric write (cluster,
 * residual) inserts a new version row and would reset the clock.
 */
export function getVerifiedAtByConcept(db: Database): Map<string, string> {
  const rows = db
    .query<{ id: string; created_at: string }, []>(
      `SELECT c.id, ch.created_at
       FROM current_concepts c
       JOIN chunks ch ON ch.id = c.active_chunk_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.id, r.created_at]));
}

/**
 * σ(c): probability the code under a concept changed since it was last
 * verified. Bound concepts: the drifted-binding ratio — evidence that the
 * code moved. Unbound concepts: age since verification over staleness_days —
 * time survives only as the weak prior where no evidence exists. Wall-clock
 * age never applies to bound concepts; it punishes stable code.
 *
 * The persisted `staleness` column is not an input: it is frozen at 0 by
 * close and 0.x by heal, and no maintenance path advances it.
 */
export function stalenessSigma(
  concept: ConceptRow,
  bindings: ConceptBindingStats | undefined,
  verifiedAt: string | undefined,
  stalenessDays: number,
  now = new Date(),
): number {
  if (bindings && bindings.total > 0) return bindings.drifted / bindings.total;
  const since = verifiedAt ?? concept.inserted_at;
  if (!since || stalenessDays <= 0) return 0;
  const ageDays = (now.getTime() - new Date(since).getTime()) / 86_400_000;
  if (!Number.isFinite(ageDays)) return 0;
  return Math.min(1, Math.max(0, ageDays / stalenessDays));
}

export function computeSigmaByConcept(
  db: Database,
  concepts: ConceptRow[],
  stalenessDays: number,
  now = new Date(),
): Map<string, number> {
  if (concepts.length === 0) return new Map();
  const bindingStats = getConceptBindingStats(db);
  const verifiedAt = getVerifiedAtByConcept(db);
  return new Map(
    concepts.map((c) => [
      c.id,
      stalenessSigma(c, bindingStats.get(c.id), verifiedAt.get(c.id), stalenessDays, now),
    ]),
  );
}

// ── §4.2 consult distribution p(c) ───────────────────────────────────────────

const CONSULT_WINDOW_DAYS = 90;
const CONSULT_HALF_LIFE_DAYS = 30;
const CONSULT_SMOOTHING_ALPHA = 1; // Laplace

/**
 * Recency-decayed consult mass per concept name.
 *
 * Per the resolved decisions (spec §8): `show` events with a concept-name
 * subject weigh 1; `ask` events weigh 1/|pack| for each concept recorded in
 * the event's meta.pack_concepts (absent on events predating that field —
 * they contribute nothing). `recall` and `trail` are excluded: their subjects
 * are not concepts. Synthetic pack entries (call-site groups) are excluded at
 * write time by the recorder.
 */
export function getConsultMassByConceptName(db: Database, now = new Date()): Map<string, number> {
  const cutoff = new Date(now.getTime() - CONSULT_WINDOW_DAYS * 86_400_000).toISOString();
  const decay = (createdAt: string): number => {
    const ageDays = (now.getTime() - new Date(createdAt).getTime()) / 86_400_000;
    return Math.pow(0.5, Math.max(0, ageDays) / CONSULT_HALF_LIFE_DAYS);
  };

  const mass = new Map<string, number>();
  const add = (name: string, amount: number) => {
    mass.set(name, (mass.get(name) ?? 0) + amount);
  };

  interface EventRow {
    event_type: string;
    subject: string | null;
    meta_json: string | null;
    created_at: string;
  }
  let rows: EventRow[];
  try {
    rows = db
      .query<EventRow, [string]>(
        `SELECT event_type, subject, meta_json, created_at
         FROM interaction_events
         WHERE created_at >= ? AND event_type IN ('show', 'ask')`,
      )
      .all(cutoff);
  } catch {
    return mass; // table may not exist yet (pre-migration)
  }

  for (const row of rows) {
    const weight = decay(row.created_at);
    if (row.event_type === "show" && row.subject) {
      add(row.subject, weight);
      continue;
    }
    if (row.event_type === "ask" && row.meta_json) {
      try {
        const meta = JSON.parse(row.meta_json) as { pack_concepts?: string[] };
        const pack = meta.pack_concepts;
        if (Array.isArray(pack) && pack.length > 0) {
          const each = weight / pack.length;
          for (const name of pack) add(name, each);
        }
      } catch {
        // malformed meta — contributes nothing
      }
    }
  }
  return mass;
}

// ── §4.2 debt — expected consulted error ─────────────────────────────────────

export interface ExpectedDebtResult {
  /**
   * Debt ∈ [0,1], or null for a concept-less mind — "no concepts" is not the
   * same claim as "no debt", and reporting 0 would let a fresh mind read as
   * perfectly healthy.
   */
  debt: number | null;
  /** Per-concept residuals, keyed by concept id. */
  residuals: Map<string, GroundednessResult>;
  /** Per-concept consult probability p(c), keyed by concept id. */
  consultShare: Map<string, number>;
  ungroundedCount: number;
  /** Bound concepts with no e_embed on record — R(c) rests on drift alone. */
  unmeasuredEmbedCount: number;
}

/** Debt = Σ p(c) · R(c). With no events, p is uniform and debt = mean R. */
export function computeExpectedDebt(
  db: Database,
  concepts: ConceptRow[],
  now = new Date(),
): ExpectedDebtResult {
  if (concepts.length === 0) {
    return {
      debt: null,
      residuals: new Map(),
      consultShare: new Map(),
      ungroundedCount: 0,
      unmeasuredEmbedCount: 0,
    };
  }

  const bindingStats = getConceptBindingStats(db);
  const consultMass = getConsultMassByConceptName(db, now);

  const residuals = new Map<string, GroundednessResult>();
  const consultShare = new Map<string, number>();
  let ungroundedCount = 0;
  let unmeasuredEmbedCount = 0;

  const totalMass =
    concepts.reduce((sum, c) => sum + (consultMass.get(c.name) ?? 0), 0) +
    CONSULT_SMOOTHING_ALPHA * concepts.length;

  let debt = 0;
  for (const concept of concepts) {
    const g = groundednessResidual(concept, bindingStats.get(concept.id));
    residuals.set(concept.id, g);
    if (g.ungrounded) ungroundedCount++;
    else if (!g.eEmbedMeasured) unmeasuredEmbedCount++;
    const p = ((consultMass.get(concept.name) ?? 0) + CONSULT_SMOOTHING_ALPHA) / totalMass;
    consultShare.set(concept.id, p);
    debt += p * g.residual;
  }

  return { debt, residuals, consultShare, ungroundedCount, unmeasuredEmbedCount };
}

// ── §4.1 state distance — the epistemic gap ──────────────────────────────────

export interface ConceptMassRow {
  concept_id: string;
  /** Confidence-weighted bound-symbol mass. */
  mass: number;
}

function getConceptMasses(db: Database): Map<string, number> {
  const rows = db
    .query<{ concept_id: string; mass: number }, []>(
      `SELECT concept_id, SUM(COALESCE(confidence, 1.0)) AS mass
       FROM concept_symbols
       GROUP BY concept_id`,
    )
    .all();
  return new Map(rows.map((r) => [r.concept_id, r.mass]));
}

/**
 * D = Σ residual·mass / Σ mass over three partitions: grounded concepts at
 * R(c) with their bound-symbol mass, uncovered code at residual 1 with its
 * symbol mass, and ungrounded concepts at residual 1 with floor mass ε
 * (the mean grounded mass; 1 when no grounded concepts exist).
 */
export function computeStateDistanceSpec(
  db: Database,
  concepts: ConceptRow[],
  opts?: { totalSymbols?: number; coveredSymbols?: number },
): number {
  if (concepts.length === 0) return 1.0;

  const bindingStats = getConceptBindingStats(db);
  const masses = getConceptMasses(db);

  let totals = { total: 0, covered: 0 };
  if (opts?.totalSymbols != null && opts?.coveredSymbols != null) {
    totals = { total: opts.totalSymbols, covered: opts.coveredSymbols };
  } else {
    const row = db
      .query<{ total: number; covered: number }, []>(
        `SELECT (SELECT COUNT(*) FROM symbols) AS total,
                (SELECT COUNT(DISTINCT symbol_id) FROM concept_symbols) AS covered`,
      )
      .get();
    totals = { total: row?.total ?? 0, covered: row?.covered ?? 0 };
  }

  const grounded: Array<{ residual: number; mass: number }> = [];
  let ungroundedCount = 0;
  for (const concept of concepts) {
    const g = groundednessResidual(concept, bindingStats.get(concept.id));
    if (g.ungrounded) {
      ungroundedCount++;
    } else {
      grounded.push({ residual: g.residual, mass: masses.get(concept.id) ?? 1 });
    }
  }

  const meanGroundedMass =
    grounded.length > 0 ? grounded.reduce((s, g) => s + g.mass, 0) / grounded.length : 1;
  const epsilon = meanGroundedMass;

  let weightedSum = grounded.reduce((s, g) => s + g.residual * g.mass, 0);
  let massSum = grounded.reduce((s, g) => s + g.mass, 0);

  const uncovered = Math.max(0, totals.total - totals.covered);
  weightedSum += uncovered; // residual 1 × symbol mass 1 each
  massSum += uncovered;

  weightedSum += ungroundedCount * epsilon; // residual 1 × floor mass ε each
  massSum += ungroundedCount * epsilon;

  if (massSum <= 0) return 0;
  return Math.min(1, weightedSum / massSum);
}
