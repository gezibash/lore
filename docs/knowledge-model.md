# Lore Knowledge Model — Formal Specification

Status: draft v0.2 (2026-08-20). Normative target for the narrative model and the
measurement model. Where the current implementation diverges, the divergence is
listed in §7. Nothing here describes new features — it names, separates, and
constrains what already exists.

This document is intended to be self-sufficient: an implementing agent needs
only this file and the repo. Design decisions are fixed in §8; locations,
storage policy, migration mechanics, and the done-checklist are in §9.

---

## 1. Objects

| Object                  | Definition                                                                                                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Symbol** `s`          | A code unit (function, class, method) with identity, location, and a `body_hash` capturing its current implementation.                                                                                        |
| **Concept** `c`         | A named prose knowledge unit. Has an active state chunk, embeddings, a binding set `B(c)`, and a lifecycle status.                                                                                            |
| **Binding** `(c, s, w)` | A claim that `c` describes `s`, with confidence `w ∈ (0,1]` and the `bound_body_hash` recorded at verification time. A binding is **drifted** when the symbol's current body hash differs from the bound one. |
| **Chunk**               | An immutable prose version on disk + DB. State chunks are concept versions; journal chunks are narrative entries. State chunks supersede, never mutate.                                                       |
| **Narrative** `n`       | A bounded exploration session with an intent, a merge-base commit recorded at open, optional declared targets, and a status.                                                                                  |
| **Commit**              | A snapshot of the concept → active-chunk mapping (the tree). Every close produces exactly one commit.                                                                                                         |

---

## 2. The narrative model

The narrative model is **git for knowledge**. The analogy is exact and should be
used in naming and documentation:

| Git             | Lore                                          |
| --------------- | --------------------------------------------- |
| branch          | narrative (merge base recorded at open)       |
| staged change   | journal entry (routed by concept designation) |
| merge commit    | close (LLM 3-way merge + commit tree)         |
| post-merge hook | close-maintenance job (async, best-effort)    |
| file            | concept                                       |

### 2.1 State machine

```
open ──► closing ──► closed
  │          │
  │          └────► close_failed ──► open (resume) | closing (retry)
  └──► abandoned
```

All narrative rows are append-only versions; `current_narratives` resolves the
latest version per id.

### 2.2 Invariants (normative)

- **N1 — Routing.** Every journal entry carries ≥1 concept designation at write
  time. When declared targets exist, designations must be inside them. Both are
  re-validated at close; entries that fail block the close with a repair path.
  No orphan knowledge.
- **N2 — Atomic close.** The authoritative merge (chunk rows, embeddings,
  concept versions, commit, tree, status flip, maintenance enqueue) is one DB
  transaction. Maintenance is queued, idempotent, and can never block or
  invalidate a committed close.
- **N3 — Merge-base conflict detection.** Conflicts are detected against the
  merge base recorded at open. Concurrent main-line changes are 3-way merged
  (LLM), recorded as `auto-merged` conflicts, never silently overwritten.
- **N4 — Close serialization.** At most one close may be in flight per mind.
  _Currently assumed_ (single daemon; close-job leases are per-job, not
  per-mind). Must be enforced — see §7.
- **N5 — Immutability.** Journal chunks are immutable after close. State chunks
  are superseded, never edited.
- **N6 — Abandonment preserves.** Abandoned narratives keep their journal
  entries (dead ends are knowledge, surfaced in the journal trail with status),
  but never contribute to concept synthesis.

### 2.3 Phase divergence (renamed)

The close-time check currently called _phase transition_ measures cosine
distance between the narrative's journal centroid and target concept
embeddings. Embedding distance measures **topical divergence**, not
contradiction — contradictory statements about the same topic are typically
_near_ in embedding space. The signal is therefore formally a
**designation-mismatch warning** ("these entries may be routed to the wrong
concept"), and must be named and presented as such. True contradiction
detection, if wanted, is an LLM/NLI maintenance job over the top-divergence
pairs only.

Thresholds over embedding distances are model-relative: they must live in
config alongside the embedding model id they were calibrated against, and be
invalidated when the model changes.

---

## 3. Measurement model — the axes

**Principle: every stored signal measures exactly one latent quantity; each
latent quantity has one combinator; composites are derived at read time from
the axes and are never written back into them.**

This replaces the current arrangement in which symbol drift feeds at least four
terms (pressure, staleness ratchet, ground_residual bump, ask-debt component)
and the combinator switches between weighted-mean and max per call site.

### 3.1 Groundedness residual `R(c) ∈ [0,1]`

_Latent quantity:_ the degree to which the concept's prose misdescribes the
current code. This is the only per-concept "debt".

Evidence:

- `e_drift(c) = drifted(c) / |B(c)|` — the **ratio** of drifted bindings.
  Replaces the count step-function (1→0.5, 2→0.7, …), which scored 1 drifted
  of 40 bindings the same as 1 of 2.
- `e_embed(c)` — cosine distance between the concept embedding and the
  confidence-weighted centroid of bound symbol embeddings (today's
  `ground_residual`).

Combinator: `R(c) = max(e_drift(c), e_embed(c))` — doubt is disjunctive;
either evidence source alone is sufficient to establish it.

Special state: a concept with `B(c) = ∅` is **ungrounded** — a distinct
lifecycle-adjacent state, displayed as its own badge, and scored `R(c) = 1` in
composites. An unverifiable claim is the least trustworthy object in the
system; it must never be excluded from measurement (today `state_distance`
gives it weight 0).

Non-evidence (must never enter `R`):

- **churn** — version-to-version distance of the _prose_ is a change rate, not
  an error estimate. Display-only.
- **lore_residual** — cluster cohesion is a graph property (§3.4). As
  per-concept pressure it punishes semantic distinctiveness and cannot be
  healed by any maintenance action; pressure that maintenance cannot reduce is
  noise.

### 3.2 Staleness `σ(c) ∈ [0,1]`

_Latent quantity:_ the probability that the underlying code changed since the
concept was last verified.

- Bound concepts: `σ(c) = e_drift(c)` combined (max) with file-level change
  evidence for bound files (mtime / commit history since last verification).
  **Wall-clock age does not appear** — time-based staleness punishes stable
  code and ignores available evidence.
- Unbound concepts: `σ(c) = min(1, age_days / staleness_days)` — time as a
  weak prior, used only where no evidence exists.

### 3.3 Coverage `C ∈ [0,1]`

`C = Σ_{s bound} m(s) / Σ_s m(s)` with symbol mass `m(s)` (1, or LOC).
Dark zones are files with zero bound symbols. Coverage is map-completeness —
an axis of its own, **not** debt. (Today raw debt and ask-debt disagree in
sign on coverage growth; under this spec, adding concepts never raises debt.)

### 3.4 Graph health

Cluster cohesion (mean intra-cluster similarity — today's `lore_residual`,
inverted), fragmentation (component count), and connectivity (Fiedler value)
form their own axis. They drive merge/split/relate suggestions.

**They never multiply or divide accuracy metrics.** The current
`sum(pressure) / (1 + fiedler)` asserts that a connected graph makes stale
prose matter less; connectivity of a similarity graph mostly measures semantic
homogeneity, so a repo with genuinely diverse subsystems carries permanently
inflated debt it cannot fix. Removed.

---

## 4. Composites (derived, read-time)

### 4.1 State distance `D ∈ [0,1]` — the epistemic gap

Partition the claim space and take the mass-weighted mean residual:

| Partition                          | Residual | Mass                                                      |
| ---------------------------------- | -------- | --------------------------------------------------------- |
| covered code, grounded concept `c` | `R(c)`   | `w_c` = confidence-weighted bound-symbol mass of `c`      |
| uncovered code                     | `1`      | its symbol mass                                           |
| ungrounded concepts                | `1`      | floor mass `ε` per concept (e.g. the mean grounded `w_c`) |

`D = Σ residual·mass / Σ mass`

This implements the existing docstring in `computeStateDistance` for real —
the current code assigns every concept an equal share and excludes ungrounded
concepts, both of which contradict the stated formula. Per-concept bound
counts are one SQL join.

### 4.2 Debt — expected consulted error

```
Debt = Σ_c p(c) · R(c)          ∈ [0,1]
p(c) = (hits(c) + α) / (Σ_c' hits(c') + αN)
```

`hits(c)` = recency-decayed consult count from interaction events (see §8 for
the decided consult definition and constants); `α` = smoothing prior; `N` =
active concept count. Cold start (no events) degrades gracefully to the
uniform prior: debt = mean `R`.

Properties this buys, all absent today:

- **Size-invariant** — `p` sums to 1, so documenting more of the codebase
  never raises debt (the current unnormalized `Σ pressure` does).
- **Hot-weighted** — a drifted concept people actually consult dominates; this
  formalizes what `computeHotStaleness` approximates.
- **Actionable** — debt is the expected error a reader ingests per consult;
  healing the hottest, wrongest concept moves it most.
- **Attributable** — one signal, one term; a drift event changes `R(c)` once.

Bands are presentation-only and live in config with the calibration note;
trend is **relative** change over a window — never the current ±0.5 absolute
delta (meaningless as the graph grows). Decided values in §8.

### 4.3 Ask-time behavior

Ask keys off (debt band, `C`, freshness):

- retrieval-widening multiplier — keep the current mechanism unchanged; it is
  the right reaction (cast a wider net when trust is low);
- ranking staleness penalty uses `σ(c)`, not concept age;
- result warnings quote the band and the specific drifted bindings.

The eight-weight ask-debt blend (27/23/18/8/10/4/5/5) is replaced by this
derivation; `confidence = 100 − debt` is dropped (no independent meaning).

---

## 5. Combinator rules (normative)

1. Within one latent quantity: **max of evidence** (doubt is disjunctive).
2. Across concepts into a composite: **probability- or mass-weighted mean**
   (expected value).
3. A composite is never stored into a component (no ratcheting `staleness` or
   `ground_residual` from drift counts at close time).
4. Every threshold and weight lives in config, annotated with the embedding
   model id it was calibrated against.

---

## 6. Signal mapping (current → spec)

| Current                                     | Becomes                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `ground_residual`                           | `e_embed(c)` input to `R(c)`                        |
| symbol-drift count steps (0.5/0.7/0.85/1.0) | `e_drift(c)` ratio                                  |
| `churn`                                     | display-only change rate; never in `R`              |
| `staleness` (age-based)                     | `σ(c)` evidence-based; age only as unbound prior    |
| `lore_residual` in pressure                 | graph-health cohesion; removed from pressure        |
| `/(1 + fiedler)` divisor                    | graph-health metric; removed from debt              |
| `computeTotalDebt` (Σ pressure)             | expected-error debt (§4.2)                          |
| ask-debt 8-component blend                  | derived presentation over `R`, `C`, freshness       |
| `state_distance` (equal-share)              | §4.1 with real masses; ungrounded included          |
| `debt = max(persisted, live)`               | one debt, recomputed from axes at read time         |
| phase transition warning                    | phase **divergence** = designation-mismatch warning |
| `theta`, `convergence`, `magnitude`         | removed from schema (always null)                   |

---

## 7. Known implementation gaps

Resolved 2026-08-20 (commits b4b4ab6, 9130394, 38ebb83): N4 per-mind close
lease; migration 027 dead narrative fields; drift ratchet deleted;
`computeStateDistance` per §4.1 with real masses and ungrounded ε; debt as
expected consulted error (`engine/measurement.ts`) with pack concepts recorded
on ask events; trend relative; fiedler divisor and lore_residual removed from
debt. Amendments encoded during implementation: `p(c)` excludes synthetic
call-site pack entries, and a concept-less mind reports debt as null — "no
concepts" is not "no debt".

Also resolved 2026-08-20 (commit 6844be3): the ask-debt blend — ask-time debt
is the expected-error debt banded by config-owned `thresholds.debt_bands`
(annotated with the embedding model); `confidence` dropped; the ranking
staleness penalty uses σ(c) with age only as the unbound prior; debt displayed
as a percentage of the stored [0,1] value.

Also resolved 2026-08-21 (axis leaks found in review of the above): every
consumer now reads R(c), σ(c) and p(c) from one `DebtSnapshot`
(`engine/debt.ts`) instead of persisted columns — status priorities, `ls`,
ask warnings/meta, concept health and suggest. Specifically: the `staleness`
column (frozen at 0 by close, never advanced) is no longer read for any
decision; σ(c) is computed by `measurement.ts#stalenessSigma` with
verification time = the active chunk's `created_at`; churn is no longer
written as `ground_residual` when e_embed cannot be measured (it stays null
and is counted as `unmeasuredEmbedCount`); the `residual` column is written
only by close maintenance as the R(c) cache (`graph.ts` no longer writes it);
and suggest's impact estimate is `p(c)·R(c)·fraction` with the Fiedler
divisor removed.

Also resolved 2026-08-21: heal is an evidence-producing action
(`engine/heal.ts`). Per concept it rescans bound files, extracts bindings only
for ungrounded concepts (re-extraction on a bound concept would wipe and
re-bind at current hashes — re-verifying every drifted binding by decree — so
it is never run there), verifies each drifted binding with the generator
against the symbol's current body (accepted → re-verified; rejected → stays
drifted with the reason, the cue to open a narrative), re-measures e_embed via
the shared `engine/ground-residual.ts` (also used by close maintenance), and
refreshes the R(c) cache. Candidates are ranked by debt share `p(c)·R(c)`.
The formula-based `healSignal` and the stop-loss halt are gone — a heal that
raises debt has _found_ debt, and halting on that would be the silent-evidence
failure. Dry runs report the evidence steps they would take.

Still open:

- **σ(c) file-change evidence.** `fileChanged(c)` needs per-file content
  change history since the concept's active chunk; today σ falls back to
  `e_drift` for bound concepts and the age prior for unbound.
- **§2.3 renaming.** Phase-divergence thresholds (0.45/0.6/0.75) are still
  code constants without model annotation, and the warning is not yet worded
  as a designation-mismatch.
- **Silent-evidence rule (amendment).** A measurement input that cannot be
  computed (missing embeddings, absent tables) must surface as its own state,
  never as a silent zero — the doc-embedding outage of 2026-08-20 read as
  "healthy, no candidates" for hours.

---

## 8. Resolved design decisions

Formerly open questions, decided 2026-08-20. Change these only by editing this
section — an implementing agent must not re-litigate them.

| Decision                  | Value                                                                                                                                                                                            | Rationale                                                                                                                          |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Consult events for `p(c)` | `show` with a concept-name subject: weight 1. `ask`: weight `1/                                                                                                                                  | pack                                                                                                                               | `for each concept in the evidence pack.`recall`and`trail` excluded (their subjects are a result section / narrative name, not a concept). | `show` already records `subject = conceptName`. Asks are the dominant consult path, so pack membership must count — but diluted, since the reader saw the concept among others. |
| Ask event payload         | Record evidence-pack concept names in ask event `meta` (today an ask stores only the query text).                                                                                                | Prerequisite for the row above; without it `p(c)` sees only explicit shows.                                                        |
| Recency decay             | Exponential, half-life 30 days, window 90 days.                                                                                                                                                  | Matches the north-star scorecard window family.                                                                                    |
| Smoothing `α`             | 1 (Laplace).                                                                                                                                                                                     | Simplest; with no events debt = mean `R`.                                                                                          |
| Symbol mass `m(s)`        | Uniform (1 per symbol).                                                                                                                                                                          | LOC-weighting favors big files; revisit only with evidence.                                                                        |
| Ungrounded floor mass `ε` | Mean `w_c` of grounded concepts, recomputed per evaluation; if no grounded concepts exist, 1.                                                                                                    | Content-length scaling rewards verbosity.                                                                                          |
| `e_embed` lane            | Code embedder preferred, text-embedder fallback.                                                                                                                                                 | Unchanged from current `ground_residual` behavior.                                                                                 |
| `e_embed` calibration     | Per embedding model only; no per-language tables.                                                                                                                                                | No evidence yet that languages need separate calibration.                                                                          |
| `σ(c)` file evidence      | `fileChanged(c)` = fraction of bound files with content change since the concept's active chunk `created_at`; contributes `min(0.5, fileChanged)`. `σ(c) = max(e_drift, min(0.5, fileChanged))`. | A file change is a weaker superset of symbol drift — it may not touch bound symbols — so it is ceilinged below the precise signal. |
| Debt bands                | healthy ≤ 0.15, caution ≤ 0.30, high ≤ 0.50, critical > 0.50.                                                                                                                                    | Initial calibration; config-owned, annotated with embedding model id.                                                              |
| Trend                     | Relative change over trailing 7 days: improving < −10%, degrading > +10%, else stable.                                                                                                           | Size-invariant by construction.                                                                                                    |
| Display                   | Debt and `R` rendered as percentages (0.23 → `23%`); stored as [0,1].                                                                                                                            | Keeps CLI output familiar.                                                                                                         |

## 9. Implementation appendix

Everything a fresh session needs beyond §1–8. Paths are repo-relative;
line numbers are as of commit `5d49d2a` — re-locate by symbol name if drifted.

### 9.1 File and table map (per §6 row)

| Spec item                                                                                                                         | Where it lives today                                                                                           |
| --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `conceptPressureBase`, `computeTotalDebt`, `computeComponentDebt`, `computeStateDistance`, `computeStaleness`, `computeDebtTrend` | `packages/core/src/engine/residuals.ts`                                                                        |
| `conceptPressure`, `computeDebtSnapshot`, drift count step-function                                                               | `packages/core/src/engine/debt.ts`                                                                             |
| Ask-debt blend (`WEIGHTS`), bands, retrieval/staleness multipliers                                                                | `packages/core/src/engine/ask-debt.ts`                                                                         |
| `lore_residual` + Fiedler computation                                                                                             | `packages/core/src/engine/graph.ts` → `recomputeGraph` (lines ~407–494)                                        |
| `ground_residual` computation, drift ratchet into `staleness`/`ground_residual`                                                   | `packages/core/src/engine/narrative-lifecycle.ts` → `runCloseMaintenanceJob` (~3593–3801; ratchet ~3759–3801)  |
| Ask-time staleness penalty (age-based)                                                                                            | `narrative-lifecycle.ts` → `queryConcepts` (~1254–1273)                                                        |
| Phase-transition detection                                                                                                        | `narrative-lifecycle.ts` → `closeNarrativeOp` (~2869–2921)                                                     |
| Close-job leasing (per-job, N4 gap)                                                                                               | `packages/core/src/db/close-jobs.ts` → `claimCloseJob` (~115)                                                  |
| Bindings, drift, coverage queries (`getDriftedBindings`, `getBindingCounts`, `getCoverageStats`, `getFileCoverage`)               | `packages/core/src/db/concept-symbols.ts`; tables `concept_symbols` → `symbols` → `source_files`               |
| Interaction events; `recordInteraction` wrapper                                                                                   | `packages/core/src/db/interaction-events.ts`; `packages/core/src/engine/index.ts` (~459, call sites ~809–3261) |
| Manifest (`debt`, `debt_trend`, `fiedler_value`, `graph_stale`)                                                                   | `packages/core/src/db/manifest.ts`                                                                             |
| Migrations                                                                                                                        | `packages/core/src/db/migrations/` (latest `028_kpis.sql`; next is 029), applied by `db/migrator.ts`           |
| Dead narrative fields (`theta`, `convergence`, `magnitude`)                                                                       | `db/narratives.ts`, `types/index.ts`, migration 027                                                            |
| Pressure/residual display                                                                                                         | `packages/core/src/formatters.ts` (~568–683), `packages/cli/src/formatters.ts`                                 |
| Suggestions consuming pressure                                                                                                    | `packages/core/src/engine/suggest.ts`                                                                          |

### 9.2 Storage policy

- **Derivable signals are computed at read time**: `e_drift` (one query over
  `concept_symbols`), `σ(c)`, `p(c)`, debt, state distance.
- **Expensive evidence is stored**: `e_embed` keeps the existing
  `ground_residual` column. The `residual` column stores `R(c)` as of the last
  maintenance run (a cache; readers may recompute `e_drift` live).
- `churn` and `staleness` columns remain for display/compat but no writer may
  ratchet them from drift, and no debt path may read them (staleness only as
  the unbound-concept prior).
- `manifest.debt` becomes a cache of the last computed [0,1] debt; the
  `max(persisted, live)` rule in `computeDebtSnapshot` is deleted — one
  read-time formula.

### 9.3 Migration & compatibility

- **Migration 027**: drop `theta`, `convergence`, `magnitude` from
  `narratives` (SQLite table rebuild — copy, drop, rename; the table is
  append-only versioned, preserve all rows). Remove the fields from
  `NarrativeRow`, `insertNarrativeVersion`, `updateNarrativeMetrics`, SDK
  types, and daemon protocol.
- **Debt rescale**: no backfill. First maintenance run (or `lore status`)
  writes the new [0,1] value over `manifest.debt`. `debt_trend` keeps its
  string values with the new relative thresholds.
- **Consumers to update in the same change**: `lore status` / `suggest`
  formatters, SDK `format-helpers`, daemon protocol payloads, and the
  `skills/goal` + KPI tooling if they read `debt` (grep `manifest.debt` and
  `ask_debt` across `packages/` and `skills/`).
- **N4 fix**: `claimCloseJob` for close jobs gains a per-mind guard — refuse
  to lease when another unexpired `leased` close job exists for the same
  `lore_path`. Queued jobs simply wait for the next claim cycle.

### 9.4 Acceptance checklist

An implementation is done when all of these hold:

- [ ] Debt ∈ [0,1] equals `Σ p(c)·R(c)`; with zero interaction events it
      equals mean `R` (test).
- [ ] Creating a new healthy concept never increases debt (test — this fails
      against `computeTotalDebt` today by construction).
- [ ] One symbol-drift event changes exactly one stored signal
      (`e_drift` input), and no write path touches `staleness` or
      `ground_residual` in response to drift (test + grep).
- [ ] `fiedler_value` and `lore_residual` are unreachable from the debt
      computation (grep) and reported under graph health instead.
- [ ] `computeStateDistance` uses confidence-weighted bound-symbol masses and
      counts ungrounded concepts at residual 1 with floor mass ε (test:
      adding an unbound concept increases D; binding it decreases D).
- [ ] Two concurrent closes for one mind serialize: second claim returns null
      until the first lease resolves (test against `claimCloseJob`).
- [ ] Ask events record evidence-pack concept names in `meta`.
- [ ] Migration 027 applies cleanly on a copy of a real mind DB;
      `theta`/`convergence`/`magnitude` gone from schema and types.
- [ ] Phase warnings renamed to divergence/designation-mismatch wording in
      results and formatters; thresholds moved to config with model id.
- [ ] Updated tests: `engine/ask-debt.test.ts`, `db/close-jobs.test.ts`,
      `db/narratives.test.ts`, `db/manifest.test.ts`,
      `db/close-maintenance-jobs.test.ts`, plus formatter snapshots.
- [ ] `bun run lint` and the full test suite pass.
