# lore

A local-first codebase knowledge system for AI agents and developers.

Lore turns a codebase into a queryable knowledge graph — named concepts, narrative exploration sessions, symbol-to-file bindings, and a running debt score. It works as a CLI and as an MCP server, so agents can ask "how does auth work?" and get a precise, grounded answer with file references instead of grepping blind.

---

## How it works

**Concepts** are named knowledge units (e.g. `auth-model`, `cache-layer`, `query-pipeline`). Each has prose content, embeddings, source symbol bindings, staleness, and a residual score that tracks drift from reality.

**Narratives** are bounded exploration sessions. You open one, write journal entries against explicit concept designations, and close it. On close, Lore groups entries by those designations, synthesizes updated concept state, commits the authoritative merge, and queues residual/binding/graph maintenance behind it. The concept graph grows with every session.

**Debt** is a score that tracks how reliable the knowledge is — how stale, how drifted from source, how clustered. Routine maintenance (heal stale concepts, merge overlaps, refresh bindings) keeps debt low.

---

## Install

Requires [Bun](https://bun.sh).

```bash
git clone https://github.com/gezibash/lore
cd lore
bun install
bun link --global --cwd packages/cli
```

This installs the `lore` CLI globally.

---

## Quick start

```bash
# Register a codebase
lore init /path/to/your/project

# Index the source (symbols, docs, source chunks)
lore ingest

# Ask a question
lore ask "how does the auth flow work?"

# Open a narrative, journal findings, close
lore open fix-auth-race "Investigate race condition in token refresh"
lore write fix-auth-race "The race is in refreshToken — two concurrent calls both pass the expiry check before either writes the new token" --concept auth-model
lore close fix-auth-race

# Check status and debt
lore status
lore suggest
```

---

## CLI

### Core workflow

| Command | Description |
|---------|-------------|
| `lore init [path] [name]` | Register a codebase |
| `lore ingest [file]` | Index source code and docs |
| `lore open <narrative> <intent>` | Start an exploration session |
| `lore write <narrative> <entry> --concept <name> [--concept <name> ...]` | Journal a finding against explicit concept designations |
| `lore ask <query>` | Query the knowledge graph |
| `lore close <narrative>` | Integrate and commit findings |

### Inspection

| Command | Description |
|---------|-------------|
| `lore status` | Health snapshot — debt, priorities, dangling narratives |
| `lore ls` | List all concepts with residuals and staleness |
| `lore show <concept>` | Full concept: content, relations, symbol bindings |
| `lore log` | Commit history with narrative context |
| `lore diff <from..to>` | Conceptual diff between two commits |
| `lore suggest` | Prioritized maintenance suggestions |

### System (`lore sys`)

Config, embeddings, migrations, concept lifecycle, provider management, MCP install:

```bash
lore sys config show
lore sys config set ai.generation.model qwen3:8b
lore sys embeddings refresh
lore sys mcp install --claude
lore sys coverage
```

---

## MCP

Lore runs as an MCP server for direct agent integration. Install the server config for your agent:

```bash
lore sys mcp install --claude    # Claude Code / Claude Desktop
lore sys mcp install --codex     # OpenAI Codex
lore sys mcp install --opencode  # OpenCode
```

Or add manually — the server is:

```bash
lore mcp
```

### Tools

`open`, `write`, `append`, `ask`, `recall`, `score`, `close`, `patch`, `relate`, `status`, `suggest`, `ls`, `show`, `trail`, `bind`, `history`, `archive`, `rename`, `merge`, `diff`, `log`, `config`, `ingest`

### Resources

| URI | Description |
|-----|-------------|
| `lore://concepts/list` | JSON snapshot of all active concepts |
| `lore://coverage/map` | Symbol coverage stats |

---

## Configuration

Lore uses layered config with this precedence (highest wins):

```
hardcoded defaults → ~/.lore/config.json → <project>/.lore/config.json → programmatic
```

On first `lore init`, `~/.lore/config.json` is seeded with readable defaults. Per-project config lives alongside your code and can be version-controlled.

### Providers

**Embedding providers:** `ollama` · `openai` · `openai-compatible` · `openrouter` · `voyage` · `gateway`

**Generation providers:** `ollama` · `openai` · `groq` · `openai-compatible` · `openrouter` · `moonshotai` · `alibaba` · `gateway`

Default (no config needed): local Ollama with `qwen3-embedding:8b` + `qwen3:8b`.

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

A separate code embedding model can be configured under `ai.embedding.code` for better symbol search (e.g. `voyage-code-3`).

---

## Architecture

Strict layered monorepo — dependency direction is one-way:

```
@lore/cli  ─┐
@lore/mcp  ─┤─→  @lore/worker  →  @lore/sdk  →  @lore/core
            ↓
       @lore/rendering
```

| Package | Role |
|---------|------|
| `@lore/core` | Engine, storage, SQLite, embeddings, search, integration |
| `@lore/sdk` | Canonical API contract over core |
| `@lore/worker` | Single-lore domain client |
| `@lore/rendering` | Shared output formatters (plain, markdown, JSON) |
| `@lore/cli` | Terminal adapter |
| `@lore/mcp` | MCP server adapter |

---

## Development

```bash
bun install          # Install deps
bun run dev          # Run CLI from source
bun run mcp          # Run MCP server from source
bun run typecheck    # Type-check all packages
bun run test         # Run all tests
bun run lint         # Lint
bun run fmt          # Format
```

---

## License

MIT
