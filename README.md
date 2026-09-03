<p align="center">
  <a href="https://github.com/gezibash/lore"><img width="520" src="docs/assets/lore-logo.png" alt="Lore"></a>
</p>

<p align="center"><strong>Lore</strong> <em>— A local-first codebase knowledge system for AI agents and developers.</em></p>
<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/runtime-Bun-f9f1e1?logo=bun&amp;logoColor=000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/language-TypeScript-3178c6?logo=typescript&amp;logoColor=white" alt="TypeScript"></a>
  <a href="https://github.com/gezibash/lore/stargazers"><img src="https://img.shields.io/github/stars/gezibash/lore?style=flat&amp;logo=github" alt="GitHub stars"></a>
  <a href="https://github.com/gezibash/lore/blob/main/package.json"><img src="https://img.shields.io/badge/version-0.4.2-0d6efd" alt="Version 0.4.2"></a>
</p>

Lore turns a codebase into a queryable knowledge graph — named concepts, narrative exploration sessions, symbol-to-file bindings, and a running debt score. It is CLI-first, so agents can ask "how does auth work?" and get a precise, grounded answer with file references instead of grepping blind.

![How Lore turns a codebase into reliable knowledge](docs/assets/lore-flow.png)

---

## How it works

**Concepts** are named knowledge units (e.g. `auth-model`, `cache-layer`, `query-pipeline`). Each has prose content, embeddings, source symbol bindings, staleness, and a residual score that tracks drift from reality.

**Narratives** are bounded exploration sessions. You open one, write journal entries against explicit concept designations, and close it. On close, Lore groups entries by those designations, synthesizes updated concept state, commits the authoritative merge, and queues residual/binding/graph maintenance behind it. The concept graph grows with every session.

**Debt** is a score that tracks how reliable the knowledge is — how stale, how drifted from source, how clustered. Routine maintenance (heal stale concepts, merge overlaps, refresh bindings) keeps debt low.

---

## Install

Download a release build. The script picks the build for your platform, checks
it against the published checksum, and links it at `~/.local/bin/lore`.

```bash
curl -fsSL https://raw.githubusercontent.com/gezibash/lore/main/install.sh | sh
```

Builds exist for Apple Silicon macOS, and for Linux on x64 and arm64.
Intel macOS has no build, because LanceDB ships no Intel macOS binary.
Pin a version with `LORE_VERSION=v0.4.2`. Remove it with
`install.sh --uninstall`.

### Stay current

```bash
lore upgrade
```

`lore upgrade` reads the latest release, then runs the install script from
that same tag. The binary, its native libraries and the migrations move
together, so the install stays complete.

lore also checks once a day, in the background, and prints one line when a
newer release exists. The check reads a cache file, so it never delays a
command. It stays quiet under `--json`, in a pipe, and on a build machine.

To turn the check off, set `LORE_NO_UPDATE_CHECK=1`.

### Build from source

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/gezibash/lore
cd lore
bun install
bun run install
```

`bun run install` builds a standalone binary and links it at `~/.local/bin/lore`. The build is copied, not symlinked, so the command keeps working while this repo is mid-edit or mid-rebase. Put `~/.local/bin` on `PATH`. If another `lore` comes earlier on `PATH`, the install says so — remove it, or the new binary never runs.

Install somewhere else with `--prefix <dir>` or `LORE_PREFIX`. Remove it with `bun run install --uninstall`.

To develop lore itself, run `bun run link:global` instead. That points the command at the working tree, so edits apply on the next invocation.

---

## Set up a project

```bash
cd /path/to/your/project

# 1. Exclude what must never enter retrieval
cat > .loreignore <<'IGNORE'
tests/
fixtures/
benchmarks/
dist/
IGNORE

# 2. Register this directory
lore init

# 3. Index it
lore ingest

# 4. Confirm coverage is not zero
lore status
```

### `.loreignore`

Write it before the first ingest. Lore reads `.gitignore` and `.loreignore`, and `.loreignore` has the highest authority. A line that starts with `!` forces a path back in.

Two failures make it necessary. Test files carry ground-truth answers that contaminate retrieval, and an unfiltered workspace indexes gigabytes.

### Choosing the root

`lore init <dir>` registers that exact directory and never returns a parent. Every other command resolves the current directory to its nearest registered ancestor, so subdirectories share the mind at the root.

For a multi-repo workspace, register one mind at the workspace root. Sub-repos then share concepts. If cross-repo answers get worse, near-duplicate code is crowding the retrieved set — scope the question with `lore ask --scope <dir>`, and split the workspace into separate minds only if that is not enough.

```bash
lore ask "how does the job queue lease work?" --scope packages/worker
```

A scope reads a repo-relative directory and is repeatable. A source chunk is
judged by its own path. Concept prose carries no path, so its symbol bindings
place it: a concept bound inside the scope stays. A concept with no bindings
stays too, because nothing places it and nothing proves it is outside. A
journal entry belongs to a session rather than a directory, so a scope does not
touch it.

List every registration with `lore sys ls`. Remove one with `lore sys remove <name>`.

### Keeping the index fresh

Lore answers from the index it built at the last ingest. After an edit that
index is behind, and nothing says so, so `lore ask` answers from the old code.

A git hook closes the gap at the commit, which is the one moment the working
tree is settled and the change is complete.

```bash
lore sys hooks install     # write the post-commit hook
lore sys hooks status      # where it is, and whether it is current
lore sys hooks uninstall   # remove it
```

The hook queues the work and returns, so a commit never waits for a scan. An
ingest reads only the files whose content changed, and the daemon collapses a
second request onto the job already queued, so a run of quick commits leaves
one job.

Queue an ingest by hand with:

```bash
lore ingest --queue
```

Install refuses in two cases, and prints the one line to add by hand instead:

- A `post-commit` hook is already there and lore did not write it. Chaining
  hooks is normal, and that file may be the only thing running git-lfs for the
  repository. Pass `--force` to replace it.
- `core.hooksPath` points outside the repository. git runs that directory for
  every repository that reads the config, so a write there installs the hook in
  all of them.

### Languages

TypeScript, JavaScript, Python, Go, Rust, Elixir, and Lean 4 get symbol
extraction. Other files are still indexed as text. Binding, `--mode code`,
and coverage need symbols. Details, including the experimental Lean
grammar, live in [docs/languages.md](docs/languages.md).

---

## Quick start

```bash
# Ask a question
lore ask "how does the auth flow work?" --sources

# Capture a finding. Lore picks the narrative and the concept.
lore note "The race is in refreshToken — two concurrent calls both pass the expiry check before either writes the new token" --symbol refreshToken --ref src/auth.ts:44-97

# When the session must reshape a concept, open with a target and write:
# lore open fix-auth-race "Investigate race condition in token refresh" --target update:auth-model
# lore write fix-auth-race "…" --concept auth-model --symbol refreshToken --ref src/auth.ts:44-97
lore close inbox --wait

# Re-index the touched file and bind the symbol
lore ingest src/auth.ts
lore bind auth-model refreshToken

# Check status and debt
lore status
lore suggest
```

---

## CLI

### Core workflow

| Command                          | Description                                                       |
| -------------------------------- | ----------------------------------------------------------------- |
| `lore init [path] [name]`        | Register a codebase. `--hooks` writes the post-commit ingest hook |
| `lore ingest [file]`             | Index source code and docs. `--force` re-chunks every file        |
| `lore note <entry>`              | Capture a finding. Lore picks the narrative and concept           |
| `lore ask <query>`               | Query the knowledge graph                                         |
| `lore open <narrative> <intent>` | Start an exploration session when you need declared targets       |
| `lore write <narrative> <entry>` | Journal a finding against explicit concept designations           |
| `lore close <narrative>`         | Queue a close job. `--wait` blocks until it finishes              |
| `lore bind <concept> <symbol>`   | Bind a source symbol to a concept                                 |
| `lore rebuild <concept>`         | Rewrite a concept body from its inputs                            |

### Rebuilding a concept

A concept is a rollup of the journal entries designated to it and the code it is bound to. `lore rebuild <concept>` recomputes the body from those inputs and discards the current prose:

```bash
lore rebuild numscript-movement-posting
```

Use it when a wrong sentence sits in a concept body. A close merges into the body, so the sentence survives. A rebuild does not read the body, so the sentence goes.

The old body stays in the version history — `lore show <concept>@<ref>` still prints it. If the generator returns an empty body, the rebuild stops and the current body stays. A concept with no journal entries cannot be rebuilt.

`lore sys rebuild` (also `lore sys rebuild-db`) is a different command. It rebuilds the database from the files on disk.

### Declaring targets on open

`lore open --target <op>:<concept>` tells the close which concepts the narrative may write. Repeat the flag once per target.

| Target                      | Effect                                  |
| --------------------------- | --------------------------------------- |
| `create:<name>`             | The narrative introduces a new concept  |
| `update:<name>`             | The narrative feeds an existing concept |
| `rename:<old>:<new>`        | Rename on close                         |
| `merge:<src>:<into>`        | Fold one concept into another           |
| `archive:<name>[:<reason>]` | Retire a concept                        |
| `split:<name>[:<parts>]`    | Break a concept apart                   |
| `restore:<name>`            | Bring an archived concept back          |

`create:<name>` against an archived name restores that concept and writes the new body onto it. The close reports the restore. If the name belongs to a concept that was merged into another, the close stops and names that concept.

`lore write` needs `--concept` unless the narrative has exactly one create/update target. Add `--symbol` for touched symbols and `--ref` for file or line references.

### Capturing without the ceremony

`lore write` asks for a narrative and a concept on every entry. That precision
pays at close. It costs at capture, and capture is where an agent gives up: a
finding never written costs more than one filed under the wrong concept,
because a close can move prose and cannot recover what nobody wrote.

`lore note` asks for neither and works both out.

```bash
lore note "Two concurrent refreshes both pass the expiry check" --ref src/auth.ts:44-97
```

Lore picks the narrative: the one open narrative, or a standing `inbox` it
opens when none is open or several are. It picks the concept by searching the
note text with the same retrieval that answers a question, so a note lands
where a reader looking for it would search. It then prints what it chose:

```
Noted in inbox (opened)
  filed under auth-model — pass --concept to override
```

`--concept` skips the search. `--narrative` skips the choice. `--symbol` and
`--ref` work as they do on `lore write`.

Lore refuses rather than guess in two cases: a lore with no concepts yet, and a
note that matches no target the narrative declared. Both name the fix.

### Asking

| Flag            | Effect                                                                   |
| --------------- | ------------------------------------------------------------------------ |
| `--mode arch`   | Architectural answer. This is the default                                |
| `--mode code`   | Injects the bodies of bound symbols. Use it for implementation questions |
| `--sources`     | Show which chunks produced the answer                                    |
| `--brief`       | Targeted excerpts instead of full dumps                                  |
| `--concise`     | A 1-2 sentence answer                                                    |
| `--search`      | Include external web search results                                      |
| `--debug`       | Trace the retrieval pipeline and explain the selection                   |
| `--scope <dir>` | Answer from one directory only (repeatable)                              |

Every ask returns a result ID. Chain follow-up work to it:

```bash
lore ask "where does close queue work?" --sources
lore recall <result-id> --section sources
lore open fix-close-latency "Cut close latency" --from-result <result-id>
lore score <result-id> 4
```

`--from-result` also works on `open`, `show`, `trail`, and `close`.

### Inspection

| Command                    | Description                                                                              |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `lore status`              | Health snapshot — debt, priorities, dangling narratives. `--details` for the full report |
| `lore ls`                  | List all concepts with residuals and staleness. `--group cluster` to group them          |
| `lore show <concept>`      | Full concept: content, relations, symbol bindings. Supports `concept@ref`                |
| `lore trail <narrative>`   | Reconstruct the full investigation trail                                                 |
| `lore log [limit] [since]` | Walk commit history. `since` takes `2w`, a ULID, or `main~N`                             |
| `lore diff <target>`       | Preview a close, or compare `ref..ref`                                                   |
| `lore suggest`             | Prioritized maintenance plan. Filter with `--kind`                                       |
| `lore usage`               | What this lore has spent on AI calls. `--all` for every lore                             |
| `lore run ls`              | List recorded runs. `lore run show <id>` for one                                         |

### Spend

Every AI call records its token counts against the lore that made it, so spend is attributable per project.

```bash
lore usage                    # this lore, grouped by model
lore usage --by operation     # where the tokens went: ask, close, ingest
lore usage --all --since 2w   # every lore, last two weeks
```

Money is priced at report time from the provider's live catalog, not stored, because a price belongs to the model today rather than to a call made last month. A model with no published price shows its tokens and no cost, and the total is marked `≥` to say it is a floor.

Recording starts when the table is created. Calls made before that are not backfilled.

### Runs and KPIs

Record structured experiment results and timeseries with provenance. See
[docs/kpis-and-runs.md](docs/kpis-and-runs.md).

### System (`lore sys`)

```bash
lore sys ls                                  # every registered lore
lore sys provider models openrouter --search glm   # catalog, with context and price
lore sys config show                         # resolved config, with override annotations
lore sys config set ai.generation.model qwen3:8b
lore sys coverage --uncovered                # exported symbols with no concept
lore bind auth-model refreshToken            # or lore sys concept bind
lore sys relations set auth-model session-store depends_on
lore sys health heal                         # refresh high-stale concepts
lore sys embeddings refresh                  # re-embed with the current model
lore sys worker --watch                      # drain queued close, ingest, and rebuild jobs
```

Also available: `narrative designate`, `migrate`, `migrate-status`, `repair`, `audit`, `rebuild`, `reset`, `remove`, and `provider` for shared credentials.

---

## The daemon

A local daemon owns the job queue. Any command starts it on demand.
`lore close` returns a job ID; use `--wait` when the next step needs the
merged concept. Jobs, merge strategies, and restart behavior:
[docs/daemon.md](docs/daemon.md).

---

## Configuration

Default (no config needed): local Ollama with `qwen3-embedding:8b` and
`qwen3:8b`. Inspect the resolved result with `lore sys config show`.
Providers, catalogs, and switching models:
[docs/providers.md](docs/providers.md).

---

## Agent skill

`skills/lore/` teaches an agent this workflow. Install it two ways: with the
skills CLI, which reaches every agent, or with lore, which carries the skill
inside the release.

```bash
lore skill install                                  # Claude Code, every project
lore skill install --agent codex --agent cursor     # other agents
lore skill install --project                        # this project only
```

`lore skill install` hands the work to the skills CLI, which reaches 70+ agents.
It passes the skill this binary carries, not the repository, so the skill always
matches the lore that installed it.

The skills CLI copies. A copy does not follow `lore upgrade`, so run
`lore skill install` again after one. `lore skill status` reports when the copy
and the binary disagree.

```bash
lore skill install --link    # link instead, and follow every upgrade
```

`--link` needs no network and no npx. The link points inside the install, so the
skill tracks the binary through an upgrade with no second command. It covers
Claude Code at the personal level only. lore falls back to it when npx is
absent.

Install from the repository instead, without lore:

```bash
npx skills add gezibash/lore
```

GitHub is the registry for that CLI, so there is nothing to publish.

```bash
lore skill status      # where it is, and whether it follows this lore
lore skill uninstall   # remove it
```

`--copy` writes a detached copy instead of a link. `lore skill status` then
reports when the copy and the binary disagree, and `lore skill install --copy`
refreshes it. `--dir` installs somewhere else.

Install refuses to overwrite a directory it does not recognise. Pass `--force`
when you mean to replace it.

---

## Architecture

Strict layered monorepo — dependency direction is one-way:

```
@lore/cli  ─┐
            ├─→  @lore/worker  →  @lore/sdk  →  @lore/core
            ↓
       @lore/rendering
```

| Package           | Role                                                     |
| ----------------- | -------------------------------------------------------- |
| `@lore/core`      | Engine, storage, SQLite, embeddings, search, integration |
| `@lore/sdk`       | Canonical API contract over core                         |
| `@lore/worker`    | Single-lore domain client and daemon                     |
| `@lore/rendering` | Shared output formatters (plain, markdown, JSON)         |
| `@lore/cli`       | Terminal adapter                                         |

---

## Development

```bash
bun install          # Install deps
bun run dev          # Run CLI from source
bun run typecheck    # Type-check all packages
bun run test         # Run all tests
bun run lint         # Lint
bun run fmt          # Format
bun run knip         # Find dead exports
bun run build        # Build dist/ without installing it
```

---

## License

MIT
