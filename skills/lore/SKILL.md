---
name: lore
description: Use Lore's CLI-first workflow in any repo: set the project up, inspect concepts, open and journal narratives, close with async jobs, ingest code and docs, and bind symbols. Trigger when a user mentions `lore`, narratives, concepts, journaling, ingesting, binding, status/suggest/ask, KPIs, switching the model or provider, or wants the agent to keep Lore updated while doing coding work.
---

# Lore

## Overview

Lore turns a codebase into a queryable knowledge graph: named concepts, narrative sessions, symbol bindings, and a debt score. Use it as part of the coding loop, not as a final summary step. Open a narrative before meaningful work, write dense entries as you learn, close when done, then ingest and bind after code changes.

Lore is CLI-only. There is no MCP surface.

## Set Up A Project

1. Install the CLI from the lore repo with `bun run install`.
   - This builds `dist/` and links a stable binary at `~/.local/bin/lore`.
   - The binary is a copy, so it keeps working while the lore repo is mid-edit.
   - Use `bun run link:global` instead only when you develop lore itself.
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
- If cross-repo answers get worse, the packs are crowded by near-duplicate code. Split the workspace into separate minds.

## Start With State

- Check the repo state with `lore status --json`. Add `--details` for the full diagnostic report.
- Inspect current concepts with `lore ls --json` and `lore show <concept>`.
- Ask for architectural context with `lore ask "<query>" --sources`.
- Bootstrap a dark lore with `lore ingest` if concepts are empty or coverage is near zero.

## Run The Default Loop

1. Orient with `status`, `ls`, `show`, and `ask`.
2. Open a narrative before meaningful work with `lore open <name> "<intent>"`.
3. Declare create/update targets on open when the work introduces or reshapes concepts.
   - Use `--target create:<concept>` when a new concept will be journaled.
   - Use `--target update:<concept>` when the narrative should feed an existing concept directly.
   - Lifecycle targets exist too: `rename:old:new`, `merge:src:into`, `archive:name[:reason]`, `split:name[:parts]`, `restore:name`.
4. Write often with `lore write <narrative> "<entry>"`.
   - Pass `--concept` unless the narrative has exactly one create/update target.
   - Add `--symbol` for touched symbols and `--ref` for file or line references.
5. Close the narrative when done with `lore close <narrative>`.
   - Close is async by default for merge mode.
   - Use `--wait` when the caller needs a completed result before continuing.
6. Ingest after code changes with `lore ingest` or `lore ingest <file>`.
7. Bind important touched symbols with `lore sys concept bind <concept> <symbol>`.

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
- `lore close --merge-strategy` selects how the entry lands: `replace` (default), `extend`, or `patch`.

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

### Switch the generation model

This is safe at any time. No re-index is needed.

```bash
lore sys provider set openrouter --api-key sk-or-...
lore sys provider use openrouter z-ai/glm-5.3-flash
```

`use` writes the current project's config only, and rejects a model the provider
does not serve. Pass `--skip-verify` to write an id the catalog does not know.
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

No catalog reports embedding dimensions, so `--dim` is required.

If you skip step 2, every stored row keeps its old model tag, lore counts all of
them as stale, and debt climbs toward 1.0. The debt bands are calibrated for
`qwen/qwen3-embedding-8b`, so the numbers change meaning under a different embedder.

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
