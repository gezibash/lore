# Lore: Local-First Knowledge System

Lore is a codebase knowledge system built as a layered monorepo. Each lore is a local codebase with its own concept graph, narrative history, and debt state.

This document defines the current architecture and philosophy. It is intentionally aligned with the codebase in `packages/*`.

## Canonical Journeys

Every feature, optimization, and design decision must serve at least one of these journeys without degrading the others. These are the only priority.

### Scorecard

| #   | Journey                          | Score | Bottleneck                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Fix the bug in auth              | 10/10 | CloseResult shows per-concept residual impact (before → after with delta) plus content_diff (adds/removes line counts) per concept. Formatter renders `[+N/-M lines]` inline. Follow-up nudges agent to scan+bind. Remaining gap: no auto-scan on close                                                                                                     |
| 2   | Add feature in unknown territory | 9/10  | ask() returns cluster_summary (deterministic narrative from peer metadata), cluster_peers, relations (direction/type), neighbors_2hop sorted by weight (multiplicative path strength as %). Formatter renders weight percentages. Gap to 10: no cluster-level summary from LLM (current is keyword-based), no cross-cluster bridge detection                |
| 3   | I'm back after two weeks         | 9/10  | status() priorities now include `last_narrative` (name/intent/closed_at) and `changed_at` per priority concept. CLI formatters render these inline. Agent sees WHEN and WHY each priority concept last changed. Gap to 10: no content-level diff in status priorities, no per-field staleness                                                               |
| 4   | The lore is wrong                | 9/10  | `last_narrative` on QueryResultMeta shows name/intent/closed_at of the narrative that last touched each concept. Auto-refresh warning fires when staleness > 0.4 AND age > 7d. Both formatters render last narrative inline. Gap to 10: no one-click "refresh this concept" action from the warning, no per-field staleness (concept-level only)            |
| 5   | Routine maintenance              | 9/10  | Per-item impact + cumulative projection. `SuggestResult.meta.projected_debt_after` computed as `total_debt - sum(expected_debt_reduction)`. Formatter renders `Projected impact: debt 4.2 → 2.8 (-33%) if all 5 acted on` before individual suggestions. Gap to 10: no before/after debt simulation per-suggestion (only cumulative), no "apply all" action |
| 6   | Explain this to me               | 10/10 | Per-claim attribution with confidence + staleness badge: claims[] has text + source_concepts + confidence + max_staleness. Rendered as `[75%] claim [concepts] — stale (68%)` when max_staleness > 40%. `⚠ low confidence` when < 50%. Remaining gap: no "click to refresh" affordance                                                                      |
| 7   | What changed while I was away    | 10/10 | `show(concept, ref)` computes diff_from_current with line-level unified diff. `log(since="2w")` works in CLI (`--since`). `ls` staleness column now shows percentages instead of text labels. Remaining gap: no per-concept diff summary in `ls` (expensive for every concept)                                                                              |
| 8   | Cross-lore query                 | N/I   | Not yet implemented. Multi-lore federation requires a coordinator layer that does not exist in the current codebase. All operations are single-lore.                                                                                                                                                                                                        |
| 9   | Bootstrap new codebase           | 9/10  | Python relative import support added alongside TS/JS — `from .utils import x` / `from ..config import y` drive dependency boost. `coverage_change` on CloseResult shows before/after coverage stats so agent sees progress without re-running bootstrap. Gap to 10: Go/Rust dependency ordering, no incremental progress event (only visible on close)      |
| 10  | Deep research                    | 9/10  | Full thread reconstruction via `trail(narrative)` returns all entries with positions, statuses, topics. ask() trail entries show `entry_index` (e.g. "3/8") so agent sees where each match falls. Gap to 10: no narrative-level intent search (FTS needed), no cross-narrative linking (related investigations)                                             |

**Overall: 9.3/10** — Update scores honestly after each change. Bottleneck must be specific and actionable.

### Journey 1: "Fix the bug in auth"

As an agent, the human asks me to fix a bug in the authentication flow. I ask the lore "how does auth work?" I get back the auth concept with its bound symbols, file locations, and recent integration history. If the concept has drifted, the lore warns me. I use this to go straight to the right files instead of grepping the whole codebase. I fix the bug, open a narrative, journal what I found (root cause, fix strategy, any invariants I discovered), and close. The lore now knows about the fix and the concept's ground_residual drops because it's more aligned with reality.

### Journey 2: "Add a feature I've never seen before"

As an agent, the human asks me to add a new feature in a part of the codebase I don't know. I ask the lore about the surrounding domain. I get back related concepts, their cluster, their symbol bindings, and how they connect in the graph. I now understand the architectural neighborhood — where things live, what depends on what, what patterns are established. I open a narrative, build the feature, journal the new patterns I established and the integration points I created. I close. A new concept emerges or an existing one grows.

### Journey 3: "I'm back after two weeks"

As an agent, I'm starting work on a codebase that's changed since my last session. I check status. I see which concepts have drifted, which have high staleness, and whether any narratives were left dangling. I know exactly what changed under me and what I can't trust. I resolve the dangling narrative, note the drifted concepts, and start my actual work with a clear picture of what's reliable and what isn't.

### Journey 4: "The lore is wrong"

As an agent, I ask the lore about a subsystem and get back a concept that's outdated — the code was restructured and the concept doesn't match anymore. The lore should have warned me (high residual, symbol drift flags). I open a narrative, journal what's actually true now, close. The concept gets re-integrated with accurate content. If it wasn't flagged, that's a bug in our drift detection.

### Journey 5: "Routine maintenance"

As an agent, between tasks I check status and suggestions. The lore tells me three concepts need healing, two could be merged, and one has symbol drift. I follow the suggestions — heal the stale ones, merge the overlapping ones, review the drifted bindings. Debt drops. The next agent session against this lore starts from a cleaner foundation.

### Journey 6: "Explain this to me"

As a human, I want to understand how a subsystem works without reading every file. I ask the lore. I get back an executive summary synthesized from the relevant concepts, with source file references I can click through. The answer should be accurate, cite its sources, and flag anything it's uncertain about. If concepts are stale, I should know that.

### Journey 7: "What changed while I was away?"

As a human, I come back to a project after time away. I check status and diff. I see which concepts were created, updated, or drifted since I last looked. I get a high-level picture of how the codebase knowledge evolved — not git commits, but conceptual changes. "Auth was restructured. Cache layer is new. The old payment concept was archived."

### Journey 8: "I work across multiple codebases"

Not yet implemented. The intended journey: as an agent, the human asks a question that spans multiple projects — "how do we handle auth across our services?" A coordinator fans out across registered lores, retrieves relevant concepts from each, ranks them globally, and returns a federated answer with attribution. Currently all lore operations are single-lore only.

### Journey 9: "Bootstrap a new codebase"

As an agent, the human registers a new codebase. I scan the source, discover symbols, and start building the initial concept graph from scratch. The first few narratives are heavy — lots of journaling to establish foundational concepts. After 3-5 narratives, the lore should have enough coverage that subsequent agents can orient quickly. The human can check coverage to see what's mapped and what's still dark.

### Journey 10: "Deep research on a hard problem"

As an agent, the human asks me to investigate a complex performance issue. I open a narrative with clear intent. I ask the lore for context on the hot path, get back relevant concepts and their symbol bindings. I dig into the code, journal findings as I go — "the bottleneck is here because X", "this invariant is violated under Y conditions", "the fix requires changing Z". Multiple entries, each one insight. I close the narrative. The lore now contains a detailed investigation trail that any future agent can retrieve when the same area comes up again.

---

## Philosophy

- **Local truth first**: each lore owns its own concept graph and debt state.
- **Contract-first platform**: SDK is the canonical contract above core. Other packages compose on top.
- **Clear break over soft compatibility**: command and surface breaks are acceptable when they improve system clarity.

## Core Concepts

- **Lore**: a registered local codebase with its own `.lore` data and concept graph.
- **Narrative**: a bounded exploration session for journaling and integration (open → write → close).
- **Worker**: single-lore domain client wrapping all operations (`open`, `write`, `ask`, `close`, concept lifecycle, status, config, rebuild).
- **Concept**: named knowledge unit with residual and staleness.
- **Residual / staleness / debt**: drift signals used to prioritize maintenance and ranking.

## Layered Architecture

Dependency direction is strict:

`adapters -> worker -> sdk -> core`

Concrete packages:

1. **Adapters**

- `@lore/cli` (human-facing terminal UX)
- `@lore/rendering` (shared output formatters for CLI)

2. **Domain client**

- `@lore/worker` (single-lore domain API)

3. **Platform contract**

- `@lore/sdk` (canonical API + types over core)

4. **Engine + storage**

- `@lore/core` (LoreEngine, storage/db/search/embedding/integration internals)

## Package Roles

### `@lore/core`

Source of truth for engine behavior and storage mechanics:

- storage and registry
- sqlite schema/migrations/repair
- embeddings/search/rerank/summary
- narrative lifecycle and concept lifecycle

No adapter concerns.

### `@lore/sdk`

Canonical contract over core:

- `LoreClient` API over `LoreEngine`
- canonical exported types
- canonical formatters and shared helpers

SDK is the stable extension point for external developers.

### `@lore/worker`

Single-lore consumer of SDK:

- wraps all local lore operations (`open`, `write`, `ask`, `close`, `status`, `ls`, `show`, `history`, `diff`, concept lifecycle, config, reset, rebuild, embeddings, scan, coverage)
- re-exports local-facing types/utilities from SDK

Worker is intentionally local-scope.

### `@lore/rendering`

Shared output formatting layer:

- plain text, markdown, and JSON rendering modes
- consumed by CLI adapters and machine-readable flows
- no domain logic; purely presentational

### `@lore/cli`

Adapter over worker and rendering:

- all commands are local-scope (single lore)
- `lore mind` subtree for maintenance/admin operations

## CLI Commands

### Core Workflow

- `lore open <narrative> <intent> [--target ...]`
- `lore write <narrative> <entry> --concept <name> [--concept <name> ...] [--ref file:lines]`
- `lore ask <query> [--mode arch|code] [--brief] [--sources]`
- `lore close <narrative> [--wait] [--mode merge|discard] [--merge-strategy ...]`
- `lore init [path] [name]`

### Inspection

- `lore status`
- `lore ls [--group cluster]`
- `lore show <concept[@ref]>`
- `lore diff <narrative|from..to>`
- `lore log [limit] [--since duration|ulid|main~N]`
- `lore suggest`
- `lore ingest [file]`
- `lore jobs` / `lore job <id>` / `lore wait <id>`

### System Administration (`lore sys <subcommand>`)

- `lore sys status` / `lore sys rebuild` / `lore sys reset [--force]`
- `lore sys embeddings refresh`
- `lore sys coverage [--uncovered] [--file path]`
- `lore sys config {show,get,set,unset,clone,prompt-preview}`
- `lore sys narrative designate <narrative> <chunk-id> --concept <name> [--concept <name> ...]`
- `lore sys concept {restore,tag,untag,tags,history,bindings,bind,unbind}`
- `lore sys relations {set,unset,list}`
- `lore sys health {compute,explain,heal}`
- `lore sys worker --once|--watch`
- `lore sys migrate` / `lore sys migrate-status` / `lore sys repair` / `lore sys audit`
- `lore sys provider {list,get,set,unset}`
- `lore sys ls` / `lore sys remove <name> [--force]`

## Architecture Rules For Contributors

1. **Do not let adapters import core or sdk directly**

- `cli` imports `@lore/worker` and `@lore/rendering`
- boundary tests enforce this

2. **Put domain orchestration in worker, not adapters**

- adapters are presentational and transport-specific
- worker owns operation semantics

3. **SDK owns canonical contract**

- new reusable types/calls go to sdk
- worker consumes sdk and adds scope-specific composition

4. **Core remains implementation substrate**

- no adapter logic in core

## Development Workflow

Use Bun.

- install: `bun install`
- typecheck all: `bun run typecheck`
- test all: `bun run test`
- format: `bun run fmt`
- lint: `bun run lint`
- run CLI: `bun run dev`

## Known Technical Debt

Source-level boundaries are enforced, but non-core tsconfigs still carry `@/*` path mapping so TypeScript can follow raw `@lore/core` source transitively during workspace development. Long-term cleanup is to publish core build artifacts (`dist` + `.d.ts`) and consume those instead of source files.
