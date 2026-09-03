---
name: lore
description: "Use Lore's CLI-first workflow in any repo: set the project up, inspect concepts, open and journal narratives, close with async jobs, ingest code and docs, and bind symbols. Trigger when a user mentions `lore`, narratives, concepts, journaling, ingesting, binding, status/suggest/ask, KPIs, switching the model or provider, or wants the agent to keep Lore updated while doing coding work."
---

# Lore

## Overview

Lore turns a codebase into a queryable knowledge graph: named concepts, narrative sessions, symbol bindings, and a debt score. Use it as part of the coding loop, not as a final summary step. Capture findings with `lore note` as you learn. Open a narrative with targets when the work will reshape concepts. Close when done, then ingest and bind after code changes.

Lore is CLI-only. There is no MCP surface.

## Set Up A Project

1. Install the CLI.
   - Release (usual): `curl -fsSL https://raw.githubusercontent.com/gezibash/lore/main/install.sh | sh`
   - From the lore repo: `bun run install` builds `dist/` and copies a stable binary to `~/.local/bin/lore`.
   - Use `bun run link:global` only when you develop lore itself.
   - If the install warns about PATH, report the warning. Do not ignore it.
2. Write `.loreignore` at the repo root before the first ingest.
   - Lore reads `.gitignore` and `.loreignore`. `.loreignore` has the highest authority.
   - A line that starts with `!` forces a path back in.
   - Exclude tests, fixtures, benchmarks, and vendored trees. Ground-truth answers in test files contaminate retrieval.
   - Exclude large generated directories. An unfiltered ingest of a big workspace indexes many gigabytes.
3. Register the repo with `lore init` from the repo root. Pass a name for a second argument if the directory name is ambiguous.
4. Index with `lore ingest`.
5. Confirm the result with `lore status` and `lore ls`.

### Choose The Root

- `lore init <dir>` registers that exact directory. It never returns a parent mind.
- Every command resolves the current directory to its nearest registered ancestor.
- For a multi-repo workspace, register one mind at the workspace root. Sub-repos then share concepts.
- If cross-repo answers get worse, the packs are crowded by near-duplicate code. Scope the question with `lore ask --scope <dir>` first. Split the workspace into separate minds only if that is not enough.

## Start With State

- Check the repo state with `lore status --json`. Add `--details` for the full diagnostic report.
- Inspect current concepts with `lore ls --json` and `lore show <concept>`.
- Ask for architectural context with `lore ask "<query>" --sources`.
- Bootstrap a dark lore with `lore ingest` if concepts are empty or coverage is near zero.

## Run The Default Loop

1. Orient with `status`, `ls`, `show`, and `ask`.
2. Capture findings with `lore note "<entry>"`. Lore picks the narrative and the concept.
   - Add `--ref` for file or line references and `--symbol` for touched symbols.
   - Pass `--concept` or `--narrative` only when you need to override the choice.
3. Open a narrative with targets when the work will create or reshape concepts:
   `lore open <name> "<intent>" --target create:<concept>` or `--target update:<concept>`.
   - Then write with `lore write <narrative> "<entry>" --concept …` so close stays precise.
   - Lifecycle targets exist too: `rename:old:new`, `merge:src:into`, `archive:name[:reason]`, `split:name[:parts]`, `restore:name`.
   - `create:name` against an archived name restores that concept and writes the new body. You do not need `lore sys concept restore` first. If the name was merged into another concept, the close stops and names it.
4. Close the narrative when done with `lore close <narrative>`.
   - Close is async by default for merge mode.
   - Use `--wait` when the caller needs a completed result before continuing.
5. Ingest after code changes with `lore ingest` or `lore ingest <file>`.
6. Bind important touched symbols with `lore bind <concept> <symbol>`.

## Ask Well

- `lore ask "<query>"` returns an architectural answer. This is the `arch` mode default.
- Add `--mode code` to inject the bodies of bound symbols. Use it for implementation questions.
- Add `--sources` to see which chunks the answer came from.
- Add `--brief` for targeted excerpts, or `--concise` for a 1-2 sentence answer.
- Add `--debug` when an answer looks wrong, to trace the retrieval pipeline.
- Every ask returns a result ID. Chain follow-up work to it with `lore recall <id>`, `lore show <concept> --from-result <id>`, `lore open <name> <intent> --from-result <id>`, and `lore score <id> <score>`.

## Journal Well

- Write one insight per entry.
- Name the concrete concept, symbol, file, and why the change matters.
- Capture invariants, causal structure, ordering, integration points, and dead ends.
- Prefer many small entries over one long recap.
- Keep narrative names task-shaped: `fix-auth-race`, `add-cache-layer`, `investigate-close-latency`.

## Handle Async Close Explicitly

- A local daemon runs the queue. Any command starts it on demand. Manage it with `lore daemon start|status|stop|logs`.
- Treat `lore close <narrative>` as queue submission unless `--wait` is set.
- Inspect queued work with `lore jobs` and `lore job <id>`.
- Wait for completion with `lore wait <id>`.
- Drain jobs in automation with `lore sys worker --once` or `lore sys worker --watch`.
- To remove a wrong sentence from a concept, run `lore rebuild <concept>`. It writes the body again from the journal entries and the bindings, and drops the current prose. The old version stays in the history. Do not archive and re-create the concept for this.
- `lore close --merge-strategy` selects how the entries land. `patch` (default) rewrites only the paragraphs the entries touch. `extend` adds and keeps every section. `correct` drops a claim the entries do not support. `replace` writes a new body from the entries and the old prose is gone.
- If you must remove text from a concept, use `--merge-strategy correct` or `--merge-strategy replace`. `patch` and `extend` never remove text.

## Report What A Project Spent

Every AI call records its tokens against the lore that made it.

```bash
lore usage                    # this lore, grouped by model
lore usage --by operation     # ask, close, ingest, and the rest
lore usage --all --since 2w   # every lore, last two weeks
```

- Money is priced at report time from the provider's catalog. It is not stored.
- A model with no published price shows tokens and no cost. The total is then
  marked `≥`, which means a floor, not a figure.
- Recording is not backfilled. Calls made before the table existed are absent.

## Track Numbers As KPIs

- Record a measurement with `lore kpi log <name> <value>`. The first log needs `--direction up|down`.
- Set a target with `lore kpi goal <name> <target>`.
- Read the trend with `lore kpi status [name]`.
- Readings attach to the sole open narrative. Pass `--narrative <name>` when several are open.

## Change The Model Or Provider

Config resolves in layers. The highest wins:

```
hardcoded defaults -> ~/.lore/config.json -> <project>/.lore/config.json -> programmatic
```

- Read the resolved result with `lore sys config show`. It annotates which layer set each key.
- `lore sys config set <key> <value>` writes the per-lore layer. It does not change other lores.
- `lore sys provider use <provider> <model> --scope global` writes the
  `~/.lore/config.json` layer instead, for every lore at once.
- Store an API key once with `lore sys provider set <provider> --api-key <key>`. Shared
  credentials apply to every registered lore.
- `lore sys provider list` shows every provider: whether a key is stored, whether its
  catalog can be listed, and which roles this lore uses it for.

### Find a model

```bash
lore sys provider models openrouter --search glm          # one provider
lore sys provider models --search glm-5.3 --sort price    # every configured provider
```

- `--sort price` is cheapest first. `--sort context` is roomiest first. Unpriced
  models sort last in both.
- Only models lore can use are shown. Use `--type embedding` to narrow, or
  `--all-kinds` to include video, image, and speech models.
- Catalogs exist for `openrouter`, `gateway`, `openai`, `groq`, and `ollama`.
  `openai-compatible` needs a base URL on the credential first.
- With no provider named, one unreachable provider is reported in a footer. The
  other providers still list.

### Check what a key has left

```bash
lore sys provider usage openrouter
```

- Only `openrouter` and `gateway` report a balance. The rest publish no endpoint
  for it.
- Read the balance before a bulk run. Calls fail when it reaches zero.
- OpenRouter reports account credit and this key's spend separately, with
  today's and this month's totals.

### Switch the generation model

This is safe at any time. No re-index is needed.

```bash
lore sys provider set openrouter --api-key sk-or-...
lore sys provider use openrouter z-ai/glm-5.3-flash
```

`use` rejects a model the provider does not serve. Pass `--skip-verify` to write
an id the catalog does not know.

Choose where it lands with `--scope`:

- `--scope project` is the default. It writes `<project>/.lore/config.json` and
  changes this repo only.
- `--scope global` writes `~/.lore/config.json` and changes every lore that has
  no project override. Use it to set your usual model once.

A project setting always wins over the global one. Both writes keep every other
key in the file, including your API key.

The two `config set` calls below do the same thing without the check:

```bash
lore sys config set ai.generation.provider openrouter
lore sys config set ai.generation.model z-ai/glm-5.3-flash
```

- For `openrouter`, the model string is the OpenRouter slug, copied exactly.
- `gateway` is Vercel AI Gateway. `openai-compatible` reaches any OpenAI-shaped
  endpoint, including Cloudflare Workers AI, once you set its base URL.
- `base_url` is optional. It defaults to `https://openrouter.ai/api/v1`.
- Generation providers: `ollama`, `openai`, `groq`, `openai-compatible`, `openrouter`,
  `moonshotai`, `alibaba`, `gateway`, `codex`.
- Control cost with `lore sys config set ai.generation.reasoning <none|low|default|high>`.
  Override one operation under `ai.generation.reasoning_overrides.<scope>`.

### Switch the embedding model

This is destructive. Do all three steps together.

1. Run `lore sys provider use <provider> <model> --embedding --dim <n>`.
2. Run `lore sys embeddings refresh`.

`--scope global` works here too, but the refresh is per lore. Every lore that
picks up the new embedding model needs its own refresh.

No catalog reports embedding dimensions, so `--dim` is required.

If you skip step 2, every stored row keeps its old model tag, lore counts all of
them as stale, and debt climbs toward 1.0. The debt bands are calibrated for
`qwen3-embedding:8b`, so the numbers change meaning under a different embedder.

- Embedding providers: `ollama`, `openai`, `openai-compatible`, `openrouter`,
  `voyage`, `gateway`.
- Defaults: local Ollama, `qwen3-embedding:8b` at 4096 dimensions, and `qwen3:8b`
  for generation.
- Set a separate code embedding model under `ai.embedding.code` for better symbol
  search. It inherits provider, base URL, and key from `ai.embedding`.

## Prefer JSON For Automation

- Use `--json` when inspecting Lore state programmatically.
- Prefer human-readable output only when the user asked for prose or terminal-oriented summaries.

## Read References When Needed

- Read `references/operating-loop.md` for scenario recipes and example command patterns.
- Read `references/errors-and-recovery.md` when Lore rejects a command or its state looks inconsistent.
