# Lore Operating Loop

## Quick Checks

- `lore status --json`
- `lore ls --json`
- `lore show <concept>`
- `lore ask "<query>" --sources`

Use these first to confirm whether the lore is already trustworthy enough to start coding.

## Onboard A Project

Do this once per repo, before any narrative work.

```bash
# From the lore repo: install a stable binary at ~/.local/bin/lore
bun run install

# In the target repo: exclude what must never enter retrieval
cat > .loreignore <<'IGNORE'
tests/
__tests__/
fixtures/
benchmarks/
dist/
IGNORE

lore init .            # registers this exact directory
lore ingest            # symbols, docs, source chunks
lore status            # confirm coverage is not zero
```

Rules:

- `.loreignore` must exist before the first ingest. Test files carry ground-truth
  answers that contaminate retrieval, and an unfiltered workspace indexes gigabytes.
- `.loreignore` beats `.gitignore`. A `!path` line forces a path back in.
- `lore init <dir>` registers that exact directory. Commands in a subdirectory
  resolve to the nearest registered ancestor.
- For a multi-repo workspace, register one mind at the workspace root.
- After a large refactor, run `lore ingest --force` to re-chunk every file.

## Bootstrap A New Repo

1. Register and ingest as above.
2. Open a narrative per subsystem instead of trying to explain the whole repo in one thread.
3. Journal what is structurally true, not just what files exist.

Example:

```bash
lore open bootstrap-auth "Map the auth subsystem and establish the first concept" --target create:auth-model
lore write bootstrap-auth "authenticateUser gates both password and token refresh paths, so failures here cascade into session creation and refresh semantics." --concept auth-model --symbol authenticateUser --ref src/auth.ts:12-88
lore close bootstrap-auth --wait
```

## Fix A Bug In A Known Area

1. Ask for context first.
2. Open a narrative tied to the bug.
3. Journal the root cause and the constraint that makes the fix correct.
4. Close, ingest, and bind the touched symbols.

Example:

```bash
lore ask "how does auth refresh work?" --sources
lore open fix-auth-refresh "Investigate and fix the refresh token race" --target update:auth-model
lore write fix-auth-refresh "Two concurrent refresh calls both pass the expiry check before either writes the rotated token, so the race is caused by the pre-write validation window." --concept auth-model --symbol refreshToken --ref src/auth.ts:44-97
lore close fix-auth-refresh --wait
lore ingest src/auth.ts
lore sys concept bind auth-model refreshToken
```

## Add A Feature In Unfamiliar Territory

1. Use `lore ask` and `lore show` before grepping blindly.
2. Open a narrative with create targets if the feature introduces a new concept.
3. Journal integration points and ordering constraints as you discover them.

Example:

```bash
lore ask "where would webhook delivery fit?" --sources
lore open add-webhooks "Add webhook delivery for event notifications" --target create:webhook-delivery
lore write add-webhooks "Webhook delivery hangs off EventBus fan-out rather than the persistence layer, so retry semantics belong in the delivery worker instead of the event writer." --concept webhook-delivery --symbol deliverWebhook --ref src/webhooks.ts:1-120
```

## Pick The Right Ask

- Architectural question: `lore ask "how does X work?" --sources` (default `arch` mode).
- Implementation question: `lore ask "why does X retry twice?" --mode code`, which
  injects the bodies of bound symbols.
- Short answer for a decision: add `--concise`. Targeted excerpts: add `--brief`.
- Wrong or thin answer: add `--debug` to trace retrieval, then fix the cause —
  missing bindings, a stale index, or a concept that was never journaled.
- Chain work to an answer with the returned result ID:

```bash
lore ask "where does close queue work?" --sources
lore open fix-close-latency "Cut close latency" --from-result <result-id>
lore score <result-id> 4
```

## Research Or Investigation Work

- Open one narrative per investigation.
- Write findings as they are discovered, including failed leads.
- Use `lore trail <narrative>` later to reconstruct the investigation history.

## Chasing A Number

- Track a metric as a KPI so each reading carries provenance (narrative, git
  head, lore commit) instead of living in a scratch CSV.
- First reading (or first goal) must say which way is better with
  `--direction up|down`; later readings only need the name and value.
- Readings attach to the sole open narrative automatically; pass
  `--narrative <name>` when several are open.
- `lore kpi status` shows latest, delta toward the goal, and remaining gap;
  `lore kpi status <name>` adds recent readings with their provenance.

Example:

```bash
lore kpi log recall@10 0.518 --direction up --meta bench=httpx
lore kpi goal recall@10 0.8
lore kpi log recall@10 0.61
lore kpi status recall@10
```

## Maintenance And Drift Work

- Start with `lore status` and `lore suggest`.
- Open a narrative for meaningful maintenance, not for trivial formatting.
- Use `lore ingest` after restructuring files so drift detection has fresh source state.

## Async Close Patterns

- A local daemon owns the queue and starts on demand. Check it with `lore daemon status`
  and read `lore daemon logs` when jobs stall.
- Use `lore close <narrative>` when the caller can continue while merge work runs.
- Use `lore close <narrative> --wait` when the next step depends on the integrated concept state.
- Inspect queue state with `lore jobs`.
- Inspect one job with `lore job <id>`.
- Wait with `lore wait <id>`.
- Run a background drain loop with `lore sys worker --watch` in heavier automation.

## Good Journal Entry Shape

Prefer entries like:

- "X is computed before Y is applied, so changes to X always affect Y in the same reconcile cycle."
- "The gate sits inside the loop, so it serializes both image changes and hash changes even though those mechanisms are otherwise independent."
- "Tried approach A, but it fails because B survives restarts as persisted state rather than process memory."

Avoid entries that only restate the diff.
