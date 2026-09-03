# Configuration and providers

## Layers

Lore uses layered config with this precedence (highest wins):

```
hardcoded defaults → ~/.lore/config.json → <project>/.lore/config.json → programmatic
```

On first `lore init`, `~/.lore/config.json` is seeded with readable defaults. Per-project config lives alongside your code and can be version-controlled. Inspect the resolved result with `lore sys config show`.

`ai.search.timeouts.executive_summary_ms` caps the answer step of `lore ask`. It defaults to 300000, because a slow model needs minutes on an architectural question. A cap the model cannot meet no longer costs the answer: `lore ask` reports the failure and prints the retrieved sources.

```bash
lore sys config set ai.search.timeouts.executive_summary_ms 120000
```

### Providers

**Embedding providers:** `ollama` · `openai` · `openai-compatible` · `openrouter` · `voyage` · `gateway`

**Generation providers:** `ollama` · `openai` · `groq` · `openai-compatible` · `openrouter` · `moonshotai` · `alibaba` · `gateway`

`gateway` is **Vercel AI Gateway**, which routes to many model providers on one key. `openai-compatible` reaches anything that speaks the OpenAI API — Cloudflare Workers AI at `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`, Together, Fireworks, a local vLLM — with no code change. Set `base_url` on the credential first.

### Picking a model

Three commands: see what you have, search what it serves, adopt one.

```bash
# What is configured, what can be listed, what this project uses
lore sys provider list

# Search one provider, or every configured one at once
lore sys provider models openrouter --search glm
lore sys provider models --search glm-5.3 --sort price

# Point this project at a model. The id is checked before it is written.
lore sys provider use openrouter z-ai/glm-5.3-flash
```

`models` sorts by id by default; `--sort price` is cheapest first and `--sort context` is roomiest first. Models with no price sort last either way. It shows only models lore can be configured with — `--type embedding` narrows further, `--all-kinds` includes the video, image, and speech models a provider may also serve.

`openrouter`, `gateway`, `openai`, `groq`, and `ollama` publish a catalog. `openai-compatible` needs a `--base-url` on the credential first. The rest have no catalog endpoint and say so. With no provider named, `models` queries every provider that has a catalog and a key; one unreachable provider is reported in a footer and the rest still list.

Check what a key has left before a long run:

```bash
lore sys provider usage openrouter
```

Only `openrouter` and `gateway` report a balance; the rest publish no such endpoint and say so. OpenRouter also splits spend for this key from the account total, and shows today's and this month's.

`use` writes to the current project by default, so the same key can drive a different model in every repo. `--scope global` writes `~/.lore/config.json` instead, setting the default for every lore; a project setting still wins over it. Either way the write keeps every other key in the file, including your API key.

Add `--embedding --dim <n>` to switch the embedding role, and `--skip-verify` to write an id the catalog does not know yet.

Default (no config needed): local Ollama with `qwen3-embedding:8b` (4096-dim) + `qwen3:8b`.

Example `~/.lore/config.json`:

```json
{
  "ai": {
    "embedding": {
      "provider": "openai",
      "model": "text-embedding-3-small",
      "dim": 1536,
      "api_key": "sk-..."
    },
    "generation": {
      "provider": "openai",
      "model": "gpt-4o-mini",
      "api_key": "sk-..."
    }
  }
}
```

A separate code embedding model can be configured under `ai.embedding.code` for better symbol search (e.g. `voyage-code-3`). It inherits provider, base URL, and key from `ai.embedding` unless you override them.
