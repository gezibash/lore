# Lore Errors And Recovery

## `NARRATIVE_ALREADY_OPEN`

Meaning:
- The requested narrative name already exists in an open state.

Recover by:
- Resuming that narrative if it is the same unit of work.
- Choosing a new narrative name if the work is different.
- Checking open work with `lore status --json`.

## `NO_ACTIVE_NARRATIVE`

Meaning:
- The narrative is not currently open, or Lore state is inconsistent.

Recover by:
- Confirming state with `lore status --json` and `lore trail <narrative>`.
- Opening a fresh narrative if the old one is closed, abandoned, or ambiguous.
- Avoiding repeated retries against a ghost narrative name; pick a new name and continue.

## `CONCEPT_NOT_FOUND`

Meaning:
- `lore write` references a concept that does not exist and the narrative does not declare a create target for it.

Recover by:
- Reopening the narrative with `--target create:<concept>` if the concept is new.
- Using `--target update:<concept>` if the concept already exists and should be inherited.
- Writing against an existing concept name if no new concept should be created.

## `database is locked`

Meaning:
- Two Lore operations are contending on SQLite.

Recover by:
- Retrying sequentially instead of in parallel.
- Avoiding concurrent `write`, `close`, `ingest`, or worker operations against the same lore.
- Inspecting whether a worker or another CLI invocation is already active.

## Close Job Stuck Or Failed

Symptoms:
- `lore close` returns quickly but the narrative never reaches `closed`.
- `lore jobs` shows `queued`, `leased`, or `failed` work longer than expected.

Recover by:
- Inspecting the queue with `lore jobs` or `lore job <id>`.
- Waiting explicitly with `lore wait <id>`.
- Running `lore sys worker --once` to drain the queue.
- Running `lore sys worker --watch` in long-lived automation.

## Empty Or Low-Value Lore

Symptoms:
- `lore ls` shows no concepts.
- Coverage is near zero.
- `ask` returns weak or stale context.

Recover by:
- Running `lore ingest`.
- Opening focused bootstrap narratives by subsystem.
- Writing structural insights rather than prose summaries.

## Trust Current CLI State Over Old Docs

- Prefer `lore --help`, `lore sys --help`, and `--json` output over stale examples.
- Do not assume MCP exists; the current Lore surface is CLI-only.
- If the repo’s Lore state looks inconsistent, report the inconsistency and continue with a fresh narrative name rather than forcing the old state.
