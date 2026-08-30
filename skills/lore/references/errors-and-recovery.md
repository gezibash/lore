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

## Edits To Lore Itself Appear To Do Nothing

Symptoms:

- A fix in the lore repo has no effect after a full re-ingest.
- Behaviour matches an older version of the code.

Cause:

- A long-lived daemon serves the code it was spawned with.

Recover by:

- Letting the daemon restart itself. It compares its start time against the newest
  `.ts` file under the workspace root and restarts before dispatch.
- Restarting by hand with `lore daemon stop` when the daemon is busy, because a
  leased job blocks the automatic restart.
- Setting `LORE_DAEMON_STALE_CHECK=0` only to opt out of the check on purpose.

The check applies only to a source checkout. A compiled binary carries its code
inside itself. To change what it runs, build and install it again.

## `Lore daemon did not start within 5 seconds`

Symptoms:

- Every command fails with this message and names the daemon log.

Recover by:

- Reading the daemon log at the path in the message. The child writes its
  startup error there.
- Starting the daemon in the foreground to watch it fail:
  `lore daemon serve --socket ~/.lore/daemon/lored.sock --db ~/.lore/daemon/queue.sqlite --log ~/.lore/daemon/daemon.log`.
- Shortening the socket path if the log reports `Failed to listen`. macOS caps
  a unix socket path at 104 characters.

## The `lore` Command Runs Old Code

Symptoms:

- `bun run install` reports success, but behaviour does not change.
- `lore --version` reports an unexpected commit.

Recover by:

- Reading the install warning. It names the earlier PATH entry that shadows
  `~/.local/bin/lore`.
- Removing or renaming that entry, including an old `bun link --global` shim.
- Confirming with `which lore` and `lore --version`.

## Ingest Indexes Too Much

Symptoms:

- `lore ingest` takes very long or consumes gigabytes.
- `ask` returns test fixtures or ground-truth answer files.

Recover by:

- Writing `.loreignore` at the repo root with tests, fixtures, benchmarks, and
  build output.
- Re-running `lore ingest --force` to re-chunk with the new exclusions.
- Checking the registered root with `lore sys ls`. A workspace root indexes every
  sub-repo.

## `lore init` Created A Second Mind

Meaning:

- `lore init <subdir>` registers that exact directory. It never returns the parent mind.

Recover by:

- Listing registrations with `lore sys ls`.
- Removing the unwanted one with `lore sys remove <name>`.
- Running `lore init` from the intended root.

## Trust Current CLI State Over Old Docs

- Prefer `lore --help`, `lore sys --help`, and `--json` output over stale examples.
- Do not assume MCP exists; the current Lore surface is CLI-only.
- If the repo’s Lore state looks inconsistent, report the inconsistency and continue with a fresh narrative name rather than forcing the old state.
