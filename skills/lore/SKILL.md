---
name: lore
description: Use Lore's CLI-first workflow in lore-enabled repos: inspect concepts, open and journal narratives, close with async jobs, ingest code and docs, and bind symbols. Trigger when a user mentions `lore`, narratives, concepts, journaling, ingesting, binding, status/suggest, or wants the agent to keep Lore updated while doing coding work.
---

# Lore

## Overview

Use Lore as part of the coding loop, not as a final summary step. Prefer the CLI, open a narrative before meaningful work, write dense entries as you learn, close when done, then ingest and bind after code changes.

## Start With State

- Check the repo state with `lore status --json`.
- Inspect current concepts with `lore ls --json` and `lore show <concept>`.
- Ask for architectural context with `lore ask "<query>" --json` or `lore ask "<query>" --sources`.
- Initialize the repo with `lore init <path>` if Lore is not registered yet.
- Bootstrap a dark lore with `lore ingest` if concepts are empty or coverage is near zero.

## Run The Default Loop

1. Orient with `status`, `ls`, `show`, and `ask`.
2. Open a narrative before meaningful work with `lore open <name> "<intent>"`.
3. Declare create/update targets on open when the work introduces or reshapes concepts.
   - Use `--target create:<concept>` when a new concept will be journaled.
   - Use `--target update:<concept>` when the narrative should feed an existing concept directly.
4. Write often with `lore write <narrative> "<entry>"`.
   - Pass `--concept` unless the narrative has exactly one create/update target.
   - Add `--symbol` for touched symbols and `--ref` for file or line references.
5. Close the narrative when done with `lore close <narrative>`.
   - Close is async by default for merge mode.
   - Use `--wait` when the caller needs a completed result before continuing.
6. Ingest after code changes with `lore ingest` or `lore ingest <file>`.
7. Bind important touched symbols with `lore sys concept bind <concept> <symbol>`.

## Journal Well

- Write one insight per entry.
- Name the concrete concept, symbol, file, and why the change matters.
- Capture invariants, causal structure, ordering, integration points, and dead ends.
- Prefer many small entries over one long recap.
- Keep narrative names task-shaped: `fix-auth-race`, `add-cache-layer`, `investigate-close-latency`.

## Handle Async Close Explicitly

- Treat `lore close <narrative>` as queue submission unless `--wait` is set.
- Inspect queued work with `lore jobs` and `lore job <id>`.
- Wait for completion with `lore wait <id>`.
- Drain jobs in automation or background workflows with `lore sys worker --once` or `lore sys worker --watch`.

## Prefer JSON For Automation

- Use `--json` when inspecting Lore state programmatically.
- Prefer human-readable output only when the user asked for prose or terminal-oriented summaries.

## Read References When Needed

- Read `references/operating-loop.md` for scenario recipes and example command patterns.
- Read `references/errors-and-recovery.md` when Lore rejects a command or its state looks inconsistent.
