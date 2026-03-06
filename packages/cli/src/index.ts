#!/usr/bin/env bun
import { defineCli, defineCommand } from "boune";
import { spawnSync } from "child_process";
import { createWorkerClient, LoreError, type WorkerClient } from "@lore/worker";
import { formatError, formatMcpInstallCli } from "./formatters.ts";
import { registerCommand } from "./commands/register.ts";
import { ensureProjectMcpConfig, type McpHarness } from "./commands/mcp-config.ts";
import { openCommand } from "./commands/open.ts";
import { logCommand } from "./commands/log.ts";
import { queryCommand } from "./commands/query.ts";
import { recallCommand } from "./commands/recall.ts";
import { scoreCommand } from "./commands/score.ts";
import { closeCommand } from "./commands/close.ts";
import { statusCommand } from "./commands/status.ts";
import { lsCommand } from "./commands/ls.ts";
import { showCommand } from "./commands/show.ts";
import { trailCommand } from "./commands/trail.ts";
import { historyCommand } from "./commands/history.ts";
import { diffCommand } from "./commands/diff.ts";
import { commitlogCommand } from "./commands/commitlog.ts";
import { rebuildCommand } from "./commands/rebuild.ts";
import { mindsListCommand, mindsRemoveCommand, mindResetCommand } from "./commands/minds.ts";
import {
  configGetCommand,
  configShowCommand,
  configSetCommand,
  configUnsetCommand,
  configPromptPreviewCommand,
  configCloneCommand,
  providerConfigListCommand,
  providerConfigGetCommand,
  providerConfigSetCommand,
  providerConfigUnsetCommand,
} from "./commands/config.ts";
import {
  systemMigrateCommand,
  systemMigrateStatusCommand,
  systemRepairCommand,
} from "./commands/system.ts";
import { refreshEmbeddingsCommand } from "./commands/embeddings.ts";
import { conceptRestoreCommand } from "./commands/concept.ts";
import {
  conceptBindingsCommand,
  conceptBindCommand,
  conceptUnbindCommand,
} from "./commands/bindings.ts";
import {
  relationsSetCommand,
  relationsUnsetCommand,
  relationsListCommand,
} from "./commands/relations.ts";
import { conceptTagCommand, conceptUntagCommand, conceptTagsListCommand } from "./commands/tags.ts";
import {
  healthComputeCommand,
  healthExplainCommand,
  healthHealCommand,
} from "./commands/health.ts";
import { suggestCommand } from "./commands/suggest.ts";
import { coverageCommand } from "./commands/scan.ts";
import { ingestFileCommand, ingestAllCommand } from "./commands/ingest.ts";
import pkg from "../package.json";

function getVersionString(): string {
  const semver = pkg.version ?? "0.0.0";
  try {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf-8",
      timeout: 1000,
    });
    const ref = result.stdout?.trim();
    if (ref) return `${semver} (${ref})`;
  } catch {}
  return semver;
}

let workerClient: WorkerClient;

function getWorker(): WorkerClient {
  if (!workerClient) {
    workerClient = createWorkerClient();
  }
  return workerClient;
}

async function startMcpServer(): Promise<void> {
  const { startMcpServer: startServer } = await import("@lore/mcp");
  await startServer({ client: getWorker() });
}

const versionString = getVersionString();
const rawArgv = process.argv.slice(2);
const isMcpServerMode = rawArgv.length === 1 && rawArgv[0] === "mcp";

const cli = defineCli({
  name: "lore",
  version: versionString,
  description: "Knowledge system for codebases",
  commands: {
    mcp: defineCommand({
      name: "mcp",
      description: "Run Lore MCP server",
      hidden: true,
      async action() {
        await startMcpServer();
      },
    }),
    open: defineCommand({
      name: "open",
      description: "Open a new narrative",
      arguments: {
        narrative: { type: "string", required: true, description: "Narrative name" },
        intent: { type: "string", required: true, description: "Intent description" },
      },
      options: {
        resolve: {
          type: "string",
          description: "Resolve dangling narrative (name:resume|abandon)",
        },
        "from-result": {
          type: "string",
          description: "Associate this follow-up with a prior lore ask result ID",
        },
        target: {
          type: "string",
          description:
            "Declare a concept target (repeatable). Syntax: op:concept, e.g. update:auth-model, rename:old:new, merge:src:into, archive:name[:reason], split:name[:parts], restore:name",
        },
      },
      async action({ args, options }) {
        const rawTargets = options.target
          ? (Array.isArray(options.target)
              ? (options.target as string[])
              : [options.target as string]
            ).filter(Boolean)
          : undefined;
        const targetSpecs = rawTargets && rawTargets.length > 0 ? rawTargets : undefined;
        await openCommand(
          getWorker(),
          args.narrative,
          args.intent,
          options.resolve as string | undefined,
          targetSpecs,
          options["from-result"] as string | undefined,
        );
      },
    }),
    write: defineCommand({
      name: "write",
      description: "Write a journal entry to an open narrative",
      arguments: {
        narrative: { type: "string", required: true, description: "Narrative name" },
        entry: { type: "string", required: true, description: "Journal entry" },
        topics: { type: "string", required: true, description: "Comma-separated topic keywords" },
      },
      options: {
        ref: { type: "string", description: "File refs (comma-separated: path or path:start-end)" },
      },
      async action({ args, options }) {
        const topics = args.topics
          .split(",")
          .map((t: string) => t.trim())
          .filter(Boolean);
        const refs = options.ref
          ? (options.ref as string)
              .split(",")
              .map((r: string) => r.trim())
              .filter(Boolean)
          : undefined;
        await logCommand(getWorker(), args.narrative, args.entry, topics, refs);
      },
    }),
    ask: defineCommand({
      name: "ask",
      description: "Ask the lore a question",
      arguments: {
        query: { type: "string", required: true, description: "Query text" },
      },
      options: {
        search: { type: "boolean", description: "Include external web search results" },
        brief: { type: "boolean", description: "Return targeted excerpts instead of full dumps" },
        sources: { type: "boolean", description: "Include matched sources in output" },
        mode: {
          type: "string",
          description: "Retrieval mode: 'arch' (default) or 'code' (injects bound symbol bodies)",
        },
      },
      async action({ args, options }) {
        await queryCommand(getWorker(), args.query, {
          search: options.search,
          brief: options.brief,
          sources: options.sources,
          mode: options.mode as "arch" | "code" | undefined,
        });
      },
    }),
    recall: defineCommand({
      name: "recall",
      description: "Recall a cached ask result by result ID",
      arguments: {
        "result-id": { type: "string", required: true, description: "Result ID from lore ask" },
      },
      options: {
        section: {
          type: "string",
          description: "Which section to show: sources, journal, symbols, or full",
        },
      },
      async action({ args, options }) {
        const section = options.section as string | undefined;
        if (
          section &&
          section !== "sources" &&
          section !== "journal" &&
          section !== "symbols" &&
          section !== "full"
        ) {
          throw new Error(`Invalid section '${section}'. Use sources|journal|symbols|full.`);
        }
        await recallCommand(
          getWorker(),
          args["result-id"],
          section as "sources" | "journal" | "symbols" | "full" | undefined,
        );
      },
    }),
    score: defineCommand({
      name: "score",
      description: "Rate a cached ask result",
      arguments: {
        "result-id": { type: "string", required: true, description: "Result ID from lore ask" },
        score: { type: "number", required: true, description: "Quality score (1-5)" },
      },
      async action({ args }) {
        if (!Number.isInteger(args.score) || args.score < 1 || args.score > 5) {
          throw new Error(`Invalid score '${args.score}'. Use an integer from 1 to 5.`);
        }
        await scoreCommand(getWorker(), args["result-id"], args.score);
      },
    }),
    trail: defineCommand({
      name: "trail",
      description: "Reconstruct the full investigation trail for a narrative",
      arguments: {
        narrative: { type: "string", required: true, description: "Narrative name" },
      },
      options: {
        "from-result": {
          type: "string",
          description: "Associate this follow-up with a prior lore ask result ID",
        },
      },
      async action({ args, options }) {
        await trailCommand(
          getWorker(),
          args.narrative,
          options["from-result"] as string | undefined,
        );
      },
    }),
    init: defineCommand({
      name: "init",
      description: "Register a codebase into the lore network",
      arguments: {
        path: {
          type: "string",
          description: "Path to the codebase (defaults to current directory)",
        },
        name: { type: "string", description: "Optional lore name" },
      },
      options: {
        claude: {
          type: "boolean",
          description: "Generate/update Claude Code MCP config (.mcp.json)",
        },
        codex: {
          type: "boolean",
          description: "Generate/update Codex MCP config (.codex/config.toml)",
        },
        opencode: {
          type: "boolean",
          description: "Generate/update OpenCode MCP config (opencode.json)",
        },
      },
      async action({ args, options }) {
        const selectedHarnesses = [
          options.claude ? "claude-code" : null,
          options.codex ? "codex" : null,
          options.opencode ? "opencode" : null,
        ].filter((item): item is McpHarness => item !== null);
        await registerCommand(
          getWorker(),
          args.path,
          args.name,
          selectedHarnesses.length > 0 ? { harnesses: selectedHarnesses } : undefined,
        );
      },
    }),
    status: defineCommand({
      name: "status",
      description: "Health snapshot for the current lore",
      options: {
        details: {
          type: "boolean",
          description: "Show the full diagnostic status report",
        },
      },
      async action({ options }) {
        await statusCommand(getWorker(), { details: Boolean(options.details) });
      },
    }),
    suggest: defineCommand({
      name: "suggest",
      description: "Get a prioritized, step-by-step healing plan for the lore",
      options: {
        limit: { type: "number", description: "Maximum suggestions to return (default: 10)" },
        kind: {
          type: "string",
          description:
            "Filter suggestions by kind (merge, relate, close-narrative, abandon-narrative, clean-relation, symbol-drift, coverage-gap, review, cluster-drift, archive)",
        },
      },
      async action({ options }) {
        await suggestCommand(getWorker(), {
          limit: options.limit as number | undefined,
          kind: options.kind as string | undefined,
        });
      },
    }),
    ls: defineCommand({
      name: "ls",
      description: "List all concepts in the current lore mind",
      options: {
        group: { type: "string", description: "Group output by: cluster" },
      },
      async action({ options }) {
        const groupRaw = options.group as string | undefined;
        if (groupRaw && groupRaw !== "cluster") {
          throw new Error(`Invalid group '${groupRaw}'. Use 'cluster'.`);
        }
        await lsCommand(getWorker(), {
          groupBy: groupRaw as "cluster" | undefined,
        });
      },
    }),
    close: defineCommand({
      name: "close",
      description: "Close a narrative (merge or discard)",
      arguments: {
        narrative: { type: "string", required: true, description: "Narrative name" },
      },
      options: {
        mode: { type: "string", description: "merge (default) or discard" },
        "merge-strategy": {
          type: "string",
          description: "replace (default), extend, or patch",
        },
        "from-result": {
          type: "string",
          description: "Associate this close with a prior lore ask result ID",
        },
      },
      async action({ args, options }) {
        const mode = (options.mode === "discard" ? "discard" : "merge") as "merge" | "discard";
        const rawStrategy = options["merge-strategy"];
        const mergeStrategy =
          rawStrategy === "extend" || rawStrategy === "patch" || rawStrategy === "correct"
            ? (rawStrategy as "extend" | "patch" | "correct")
            : rawStrategy === "replace"
              ? ("replace" as const)
              : undefined;
        await closeCommand(
          getWorker(),
          args.narrative,
          mode,
          mergeStrategy,
          options["from-result"] as string | undefined,
        );
      },
    }),
    ingest: defineCommand({
      name: "ingest",
      description:
        "Index the codebase — scan code and ingest docs. Pass a file path to ingest a single document.",
      arguments: {
        file: { type: "string", required: false, description: "Specific file to ingest" },
      },
      async action({ args }) {
        const file = args.file as string | undefined;
        if (file) {
          await ingestFileCommand(getWorker(), file);
        } else {
          await ingestAllCommand(getWorker());
        }
      },
    }),
    sys: defineCommand({
      name: "sys",
      description: "System administration for the current lore",
      subcommands: {
        rebuild: defineCommand({
          name: "rebuild",
          description: "Rebuild DB from disk for the current lore",
          async action() {
            await rebuildCommand(getWorker());
          },
        }),
        coverage: defineCommand({
          name: "coverage",
          description: "Show symbol coverage stats for the lore mind",
          options: {
            uncovered: {
              type: "boolean",
              description: "List uncovered exported symbols",
            },
            file: {
              type: "string",
              description: "Filter to a specific file path",
            },
          },
          action({ options }) {
            coverageCommand(getWorker(), {
              uncovered: options.uncovered,
              file: options.file as string | undefined,
            });
          },
        }),
        embeddings: defineCommand({
          name: "embeddings",
          description: "Embedding maintenance commands for the current lore",
          subcommands: {
            refresh: defineCommand({
              name: "refresh",
              description: "Refresh all embeddings with the current model",
              async action() {
                await refreshEmbeddingsCommand(getWorker());
              },
            }),
          },
        }),
        reset: defineCommand({
          name: "reset",
          description: "Wipe all data for the current lore (keeps registration)",
          options: {
            force: { type: "boolean", description: "Skip confirmation" },
          },
          async action({ options }) {
            await mindResetCommand(getWorker(), options.force);
          },
        }),
        relations: defineCommand({
          name: "relations",
          description: "Manage concept relations in the current lore mind",
          subcommands: {
            set: defineCommand({
              name: "set",
              description: "Create or update a relation between two concepts",
              arguments: {
                from: { type: "string", required: true, description: "Source concept" },
                to: { type: "string", required: true, description: "Target concept" },
                type: {
                  type: "string",
                  required: true,
                  description: "Relation type (depends_on|constrains|implements|uses|related_to)",
                },
              },
              options: {
                weight: { type: "number", description: "Relation weight (0..1)" },
              },
              async action({ args, options }) {
                const relationType = args.type as
                  | "depends_on"
                  | "constrains"
                  | "implements"
                  | "uses"
                  | "related_to";
                if (
                  relationType !== "depends_on" &&
                  relationType !== "constrains" &&
                  relationType !== "implements" &&
                  relationType !== "uses" &&
                  relationType !== "related_to"
                ) {
                  throw new Error(
                    `Invalid relation type '${args.type}'. Use depends_on|constrains|implements|uses|related_to.`,
                  );
                }
                await relationsSetCommand(
                  getWorker(),
                  args.from,
                  args.to,
                  relationType,
                  options.weight,
                );
              },
            }),
            unset: defineCommand({
              name: "unset",
              description: "Remove relation(s) between two concepts",
              arguments: {
                from: { type: "string", required: true, description: "Source concept" },
                to: { type: "string", required: true, description: "Target concept" },
              },
              options: {
                type: {
                  type: "string",
                  description:
                    "Optional relation type (depends_on|constrains|implements|uses|related_to)",
                },
              },
              async action({ args, options }) {
                const relationType = options.type as
                  | "depends_on"
                  | "constrains"
                  | "implements"
                  | "uses"
                  | "related_to"
                  | undefined;
                if (
                  relationType &&
                  relationType !== "depends_on" &&
                  relationType !== "constrains" &&
                  relationType !== "implements" &&
                  relationType !== "uses" &&
                  relationType !== "related_to"
                ) {
                  throw new Error(
                    `Invalid relation type '${relationType}'. Use depends_on|constrains|implements|uses|related_to.`,
                  );
                }
                await relationsUnsetCommand(getWorker(), args.from, args.to, relationType);
              },
            }),
            list: defineCommand({
              name: "list",
              description: "List concept relations",
              options: {
                concept: { type: "string", description: "Filter to one concept" },
                all: { type: "boolean", description: "Include inactive relations" },
              },
              async action({ options }) {
                await relationsListCommand(getWorker(), {
                  concept: options.concept as string | undefined,
                  includeInactive: options.all,
                });
              },
            }),
          },
        }),
        health: defineCommand({
          name: "health",
          description: "Compute and manage concept health signals",
          subcommands: {
            compute: defineCommand({
              name: "compute",
              description: "Compute concept health signals",
              options: {
                top: { type: "number", description: "Top stale concepts to return" },
              },
              async action({ options }) {
                await healthComputeCommand(getWorker(), options.top);
              },
            }),
            explain: defineCommand({
              name: "explain",
              description: "Explain concept health and neighbors",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
              },
              options: {
                "neighbor-limit": { type: "number", description: "Max neighbors to include" },
                recompute: { type: "boolean", description: "Recompute signals before explaining" },
              },
              async action({ args, options }) {
                await healthExplainCommand(getWorker(), args.concept, {
                  neighborLimit: options["neighbor-limit"] as number | undefined,
                  recompute: options.recompute,
                });
              },
            }),
            heal: defineCommand({
              name: "heal",
              description: "Heal high-stale concepts in the current lore",
              options: {
                threshold: { type: "number", description: "Final stale threshold (0..1)" },
                limit: { type: "number", description: "Maximum concepts to heal" },
                dry: { type: "boolean", description: "Preview only; do not apply" },
              },
              async action({ options }) {
                await healthHealCommand(getWorker(), {
                  threshold: options.threshold as number | undefined,
                  limit: options.limit as number | undefined,
                  dry: options.dry,
                });
              },
            }),
          },
        }),
        config: defineCommand({
          name: "config",
          description: "Manage local config overrides",
          subcommands: {
            show: defineCommand({
              name: "show",
              description: "Show the current resolved config with override annotations",
              options: {
                overrides: {
                  type: "boolean",
                  description: "Show only keys with local overrides",
                },
              },
              async action({ options }) {
                await configShowCommand(getWorker(), { overridesOnly: options.overrides });
              },
            }),
            get: defineCommand({
              name: "get",
              description: "Get a config value",
              arguments: {
                key: {
                  type: "string",
                  required: true,
                  description: "Config key (dot-path, e.g. ai.generation.model)",
                },
              },
              async action({ args }) {
                await configGetCommand(getWorker(), args.key);
              },
            }),
            set: defineCommand({
              name: "set",
              description: "Set a config value",
              arguments: {
                key: { type: "string", required: true, description: "Config key (dot-path)" },
                value: { type: "string", required: true, description: "Value to set" },
              },
              async action({ args }) {
                await configSetCommand(getWorker(), args.key, args.value);
              },
            }),
            unset: defineCommand({
              name: "unset",
              description: "Remove a config override",
              arguments: {
                key: { type: "string", required: true, description: "Config key (dot-path)" },
              },
              async action({ args }) {
                await configUnsetCommand(getWorker(), args.key);
              },
            }),
            clone: defineCommand({
              name: "clone",
              description: "Clone full config overrides from another lore",
              arguments: {
                lore: { type: "string", required: true, description: "Source lore name" },
              },
              async action({ args }) {
                await configCloneCommand(getWorker(), args.lore);
              },
            }),
            "prompt-preview": defineCommand({
              name: "prompt-preview",
              description: "Preview effective system prompt contract + project guidance",
              arguments: {
                key: { type: "string", required: true, description: "Prompt key or 'all'" },
              },
              async action({ args }) {
                await configPromptPreviewCommand(getWorker(), args.key);
              },
            }),
          },
        }),
        concept: defineCommand({
          name: "concept",
          description: "Concept management",
          subcommands: {
            restore: defineCommand({
              name: "restore",
              description: "Emergency restore of an archived concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
              },
              async action({ args }) {
                await conceptRestoreCommand(getWorker(), args.concept);
              },
            }),
            tag: defineCommand({
              name: "tag",
              description: "Attach a tag to a concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
                tag: { type: "string", required: true, description: "Tag value" },
              },
              async action({ args }) {
                await conceptTagCommand(getWorker(), args.concept, args.tag);
              },
            }),
            untag: defineCommand({
              name: "untag",
              description: "Remove a tag from a concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
                tag: { type: "string", required: true, description: "Tag value" },
              },
              async action({ args }) {
                await conceptUntagCommand(getWorker(), args.concept, args.tag);
              },
            }),
            tags: defineCommand({
              name: "tags",
              description: "List concept tags",
              options: {
                concept: { type: "string", description: "Optional concept filter" },
              },
              async action({ options }) {
                await conceptTagsListCommand(getWorker(), options.concept as string | undefined);
              },
            }),
            history: defineCommand({
              name: "history",
              description: "Show concept history",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
              },
              async action({ args }) {
                await historyCommand(getWorker(), args.concept);
              },
            }),
            bindings: defineCommand({
              name: "bindings",
              description: "List symbol bindings for a concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
              },
              async action({ args }) {
                await conceptBindingsCommand(getWorker(), args.concept);
              },
            }),
            bind: defineCommand({
              name: "bind",
              description: "Bind a source symbol to a concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
                symbol: { type: "string", required: true, description: "Symbol qualified name" },
              },
              options: {
                confidence: { type: "number", description: "Binding confidence [0–1]" },
              },
              async action({ args, options }) {
                await conceptBindCommand(
                  getWorker(),
                  args.concept,
                  args.symbol,
                  options.confidence as number | undefined,
                );
              },
            }),
            unbind: defineCommand({
              name: "unbind",
              description: "Remove a symbol binding from a concept",
              arguments: {
                concept: { type: "string", required: true, description: "Concept name" },
                symbol: { type: "string", required: true, description: "Symbol qualified name" },
              },
              async action({ args }) {
                await conceptUnbindCommand(getWorker(), args.concept, args.symbol);
              },
            }),
          },
        }),
        mcp: defineCommand({
          name: "mcp",
          description: "MCP server configuration for the current lore",
          subcommands: {
            install: defineCommand({
              name: "install",
              description: "Install Lore MCP server config for AI editors",
              options: {
                claude: { type: "boolean", description: "Install for Claude Code (.mcp.json)" },
                codex: { type: "boolean", description: "Install for Codex (.codex/config.toml)" },
                opencode: { type: "boolean", description: "Install for OpenCode (opencode.json)" },
              },
              async action({ options }) {
                const selected = [
                  options.claude ? "claude-code" : null,
                  options.codex ? "codex" : null,
                  options.opencode ? "opencode" : null,
                ].filter(Boolean) as McpHarness[];
                const codePath = process.cwd();
                const result = await ensureProjectMcpConfig(
                  codePath,
                  selected.length > 0 ? { harnesses: selected } : undefined,
                );
                console.log(formatMcpInstallCli(codePath, result));
              },
            }),
          },
        }),
        migrate: defineCommand({
          name: "migrate",
          description: "Run pending database migrations",
          async action() {
            await systemMigrateCommand(getWorker());
          },
        }),
        "migrate-status": defineCommand({
          name: "migrate-status",
          description: "Show applied and pending migrations",
          async action() {
            await systemMigrateStatusCommand(getWorker());
          },
        }),
        repair: defineCommand({
          name: "repair",
          description: "Audit and repair database schema inconsistencies",
          options: {
            dry: {
              type: "boolean",
              description: "Audit only (no changes); exits non-zero on drift",
            },
          },
          async action({ options }) {
            await systemRepairCommand(getWorker(), options.dry);
          },
        }),
        audit: defineCommand({
          name: "audit",
          description: "Audit database schema drift (equivalent to repair --dry)",
          async action() {
            await systemRepairCommand(getWorker(), true);
          },
        }),
        remove: defineCommand({
          name: "remove",
          description: "Remove a registered lore",
          arguments: {
            name: { type: "string", required: true, description: "Lore mind name" },
          },
          options: {
            force: { type: "boolean", description: "Skip confirmation" },
          },
          async action({ args, options }) {
            await mindsRemoveCommand(getWorker(), args.name, options.force);
          },
        }),
        provider: defineCommand({
          name: "provider",
          description: "Manage shared provider credentials",
          subcommands: {
            list: defineCommand({
              name: "list",
              description: "List shared provider credentials",
              async action() {
                await providerConfigListCommand(getWorker());
              },
            }),
            get: defineCommand({
              name: "get",
              description: "Get shared provider credential metadata",
              arguments: {
                provider: { type: "string", required: true, description: "Provider name" },
              },
              async action({ args }) {
                await providerConfigGetCommand(getWorker(), args.provider);
              },
            }),
            set: defineCommand({
              name: "set",
              description: "Set shared provider credential values",
              arguments: {
                provider: { type: "string", required: true, description: "Provider name" },
              },
              options: {
                "api-key": { type: "string", description: "Provider API key" },
                "base-url": { type: "string", description: "Provider base URL" },
              },
              async action({ args, options }) {
                await providerConfigSetCommand(getWorker(), args.provider, {
                  apiKey: options["api-key"],
                  baseUrl: options["base-url"],
                });
              },
            }),
            unset: defineCommand({
              name: "unset",
              description: "Unset shared provider credential values",
              arguments: {
                provider: { type: "string", required: true, description: "Provider name" },
              },
              options: {
                "api-key": { type: "boolean", description: "Unset api_key field only" },
                "base-url": { type: "boolean", description: "Unset base_url field only" },
              },
              async action({ args, options }) {
                await providerConfigUnsetCommand(getWorker(), args.provider, {
                  apiKey: options["api-key"],
                  baseUrl: options["base-url"],
                });
              },
            }),
          },
        }),
        ls: defineCommand({
          name: "ls",
          description: "List all registered lores",
          async action() {
            await mindsListCommand(getWorker());
          },
        }),
      },
    }),
    show: defineCommand({
      name: "show",
      description: "Show concept content (supports concept@ref syntax)",
      arguments: {
        target: { type: "string", required: true, description: "Concept name or concept@ref" },
      },
      options: {
        "from-result": {
          type: "string",
          description: "Associate this follow-up with a prior lore ask result ID",
        },
      },
      async action({ args, options }) {
        await showCommand(getWorker(), args.target, options["from-result"] as string | undefined);
      },
    }),
    diff: defineCommand({
      name: "diff",
      description: "Preview close or compare commits (narrative or ref..ref)",
      arguments: {
        target: {
          type: "string",
          required: true,
          description: "Narrative name or ref..ref range",
        },
      },
      async action({ args }) {
        await diffCommand(getWorker(), args.target);
      },
    }),
    log: defineCommand({
      name: "log",
      description: "Walk commit history",
      arguments: {
        limit: { type: "number", default: 20, description: "Number of commits to show" },
        since: {
          type: "string",
          description: "Time filter: duration (2w, 3d, 12h), ULID, or main~N",
        },
      },
      async action({ args }) {
        await commitlogCommand(getWorker(), args.limit, args.since);
      },
    }),
  },
  onError(error) {
    if (error instanceof LoreError) {
      console.log(formatError(`[${error.code}] ${error.message}`));
      if (error.details) {
        console.log(JSON.stringify(error.details, null, 2));
      }
    } else {
      console.log(formatError(error instanceof Error ? error.message : String(error)));
    }
    process.exit(1);
  },
});

if (isMcpServerMode) {
  await startMcpServer();
} else {
  await cli.run(rawArgv);
}
