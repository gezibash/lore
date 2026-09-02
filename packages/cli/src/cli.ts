import { spawnSync } from "child_process";
import { createWorkerClient, serveLoreDaemon, LoreError, type WorkerClient } from "@lore/worker";
import { formatError } from "./formatters.ts";
import { buildCommanderCli } from "./commander-adapter.ts";
import { isInteractiveOutputEnabled } from "./tty.ts";
import { refreshUpdateCache, runUpgrade, updateNotice } from "./update.ts";
import {
  describeSkill,
  installSkill,
  installWithNpx,
  npxAvailable,
  uninstallSkill,
} from "./skill.ts";
import { defineCli, defineCommand } from "./cli-schema.ts";
import { registerCommand } from "./commands/register.ts";
import { openCommand } from "./commands/open.ts";
import { logCommand } from "./commands/log.ts";
import { noteCommand } from "./commands/note.ts";
import { runListCommand, runLogCommand, runShowCommand } from "./commands/run.ts";
import { parseSince } from "./commands/usage.ts";
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
import { usageCommand } from "./commands/usage.ts";
import { mindsListCommand, mindsRemoveCommand, mindResetCommand } from "./commands/minds.ts";
import {
  configGetCommand,
  configShowCommand,
  configSetCommand,
  configUnsetCommand,
  configPromptPreviewCommand,
  configCloneCommand,
  providerConfigListCommand,
  providerModelsCommand,
  providerUsageCommand,
  providerUseCommand,
  providerConfigGetCommand,
  providerConfigSetCommand,
  providerConfigUnsetCommand,
} from "./commands/config.ts";
import {
  systemMigrateCommand,
  systemMigrateStatusCommand,
  systemRepairCommand,
  systemPruneCommand,
  systemVacuumCommand,
} from "./commands/system.ts";
import { refreshEmbeddingsCommand } from "./commands/embeddings.ts";
import { conceptRebuildCommand, conceptRestoreCommand } from "./commands/concept.ts";
import { narrativeDesignateCommand } from "./commands/narrative.ts";
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
import { kpiGoalCommand, kpiLogCommand, kpiStatusCommand } from "./commands/kpi.ts";
import {
  healthComputeCommand,
  healthExplainCommand,
  healthHealCommand,
} from "./commands/health.ts";
import { suggestCommand } from "./commands/suggest.ts";
import { coverageCommand } from "./commands/scan.ts";
import { ingestFileCommand, ingestAllCommand, queueIngestAllCommand } from "./commands/ingest.ts";
import { describeHook, installHook, manualHookLine, uninstallHook } from "./hooks.ts";
import { closeJobCommand, closeJobsCommand, waitCommand } from "./commands/jobs.ts";
import { workerCommand } from "./commands/worker.ts";
import {
  daemonLogsCommand,
  daemonStartCommand,
  daemonStatusCommand,
  daemonStopCommand,
} from "./commands/daemon.ts";
import { isJsonOutput, setJsonOutput } from "./output.ts";
import pkg from "../package.json";

export interface LoreCliDeps {
  createWorker?: () => WorkerClient;
  versionString?: string;
  exit?: (code: number) => void | never;
}

/** Replaced at build time by scripts/build.ts. Absent when run from source. */
declare const LORE_BUILD_SHA: string | undefined;

export function getVersionString(): string {
  const semver = pkg.version ?? "0.0.0";

  // A compiled binary states the commit it was built from. Asking git instead
  // would answer for the caller's working directory, so a four-day-old binary
  // reported today's HEAD whenever it ran inside this repository.
  if (typeof LORE_BUILD_SHA !== "undefined" && LORE_BUILD_SHA) {
    return `${semver} (${LORE_BUILD_SHA})`;
  }

  // Running from source: git is the truth, because the source is the build.
  try {
    const result = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dir,
      encoding: "utf-8",
      timeout: 1000,
    });
    const ref = result.stdout?.trim();
    if (ref) return `${semver} (${ref} from source)`;
  } catch {}
  return semver;
}

function parseKpiDirection(raw: string | undefined): "up" | "down" | undefined {
  if (raw === undefined) return undefined;
  if (raw === "up" || raw === "down") return raw;
  throw new Error(`Invalid --direction '${raw}'. Use up or down.`);
}

function handleCliError(error: unknown, exit: (code: number) => void | never): void {
  const normalizedMessage =
    error instanceof Error ? error.message.replace(/^error:\s*/i, "") : String(error);
  if (isJsonOutput()) {
    if (error instanceof LoreError) {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: error.code,
              message: error.message,
              details: error.details ?? null,
            },
          },
          null,
          2,
        ),
      );
    } else {
      console.log(
        JSON.stringify(
          {
            ok: false,
            error: {
              code: "CLI_ERROR",
              message: normalizedMessage,
            },
          },
          null,
          2,
        ),
      );
    }
    exit(1);
    return;
  }
  if (error instanceof LoreError) {
    console.log(formatError(`[${error.code}] ${error.message}`));
    if (error.details) {
      console.log(JSON.stringify(error.details, null, 2));
    }
  } else {
    console.log(formatError(normalizedMessage));
  }
  exit(1);
}

export function createLoreCli(deps: LoreCliDeps = {}) {
  let workerClient: WorkerClient | undefined;

  const getWorker = (): WorkerClient => {
    if (!workerClient) {
      workerClient = deps.createWorker ? deps.createWorker() : createWorkerClient();
    }
    return workerClient;
  };

  const versionString = deps.versionString ?? getVersionString();
  const exit =
    deps.exit ??
    ((code: number): never => {
      process.exit(code);
    });

  const spec = defineCli({
    name: "lore",
    version: versionString,
    description: "Knowledge system for codebases",
    globalOptions: {
      json: {
        type: "boolean",
        short: "j",
        description: "Emit JSON output",
      },
    },
    commands: {
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
            repeatable: true,
            description:
              "Resolve a dangling narrative (repeatable): name:resume|abandon. Repeat it once per dangling narrative — any unresolved one blocks the open.",
          },
          "from-result": {
            type: "string",
            description: "Associate this follow-up with a prior lore ask result ID",
          },
          target: {
            type: "string",
            repeatable: true,
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
            options.resolve as string | string[] | undefined,
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
        },
        options: {
          concept: {
            type: "string",
            repeatable: true,
            description:
              "Concept designation (repeatable). Required unless the narrative has exactly one create/update target.",
          },
          topic: {
            type: "string",
            repeatable: true,
            description:
              "Optional topic keyword (repeatable). Defaults to the concept names when omitted.",
          },
          symbol: {
            type: "string",
            repeatable: true,
            description: "Optional symbol qualified name (repeatable).",
          },
          ref: {
            type: "string",
            description: "File refs (comma-separated: path or path:start-end)",
          },
        },
        async action({ args, options }) {
          const concepts = options.concept
            ? (Array.isArray(options.concept)
                ? (options.concept as string[])
                : [options.concept as string]
              )
                .map((concept: string) => concept.trim())
                .filter(Boolean)
            : [];
          const topics = options.topic
            ? (Array.isArray(options.topic)
                ? (options.topic as string[])
                : [options.topic as string]
              )
                .map((topic: string) => topic.trim())
                .filter(Boolean)
            : [];
          const symbols = options.symbol
            ? (Array.isArray(options.symbol)
                ? (options.symbol as string[])
                : [options.symbol as string]
              )
                .map((symbol: string) => symbol.trim())
                .filter(Boolean)
            : [];
          const refs = options.ref
            ? (options.ref as string)
                .split(",")
                .map((r: string) => r.trim())
                .filter(Boolean)
            : undefined;
          await logCommand(getWorker(), args.narrative, args.entry, {
            concepts,
            topics,
            symbols,
            refs,
          });
        },
      }),
      note: defineCommand({
        name: "note",
        description:
          "Capture a finding. Picks the narrative and the concept for you unless you name them.",
        arguments: {
          entry: { type: "string", required: true, description: "What you found" },
        },
        options: {
          concept: {
            type: "string",
            repeatable: true,
            description: "File it under this concept instead of the one the text selects",
          },
          symbol: {
            type: "string",
            repeatable: true,
            description: "Optional symbol qualified name (repeatable).",
          },
          ref: {
            type: "string",
            description: "File refs (comma-separated: path or path:start-end)",
          },
          narrative: {
            type: "string",
            description: "Write to this narrative instead of the one lore would choose",
          },
        },
        async action({ args, options }) {
          const list = (raw: unknown): string[] =>
            raw
              ? (Array.isArray(raw) ? (raw as string[]) : [raw as string])
                  .map((value) => value.trim())
                  .filter(Boolean)
              : [];
          const refs = options.ref
            ? (options.ref as string)
                .split(",")
                .map((value: string) => value.trim())
                .filter(Boolean)
            : undefined;
          await noteCommand(getWorker(), args.entry, {
            concepts: list(options.concept),
            symbols: list(options.symbol),
            refs,
            narrative: options.narrative as string | undefined,
          });
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
          concise: {
            type: "boolean",
            description: "Return a short, direct answer (1-2 sentences)",
          },
          sources: { type: "boolean", description: "Include matched sources in output" },
          mode: {
            type: "string",
            description: "Retrieval mode: 'arch' (default) or 'code' (injects bound symbol bodies)",
          },
          scope: {
            type: "string",
            repeatable: true,
            description:
              "Limit the answer to a directory (repeatable). Repo-relative, e.g. packages/core",
          },
          debug: {
            type: "boolean",
            description: "Trace the retrieval pipeline and print why this answer was selected",
          },
        },
        async action({ args, options }) {
          await queryCommand(getWorker(), args.query, {
            search: options.search,
            brief: options.brief,
            concise: options.concise,
            sources: options.sources,
            mode: options.mode as "arch" | "code" | undefined,
            debug: options.debug,
            scopes: options.scope
              ? (Array.isArray(options.scope)
                  ? (options.scope as string[])
                  : [options.scope as string]
                )
                  .map((value) => value.trim())
                  .filter(Boolean)
              : undefined,
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
      run: defineCommand({
        name: "run",
        description: "Record what a run was given and what it produced",
        subcommands: {
          log: defineCommand({
            name: "log",
            description: "Record a run",
            arguments: {
              name: { type: "string", required: true, description: "Run name, e.g. sweep-42" },
            },
            options: {
              param: {
                type: "string",
                repeatable: true,
                description: "An input, as key=value (repeatable)",
              },
              metric: {
                type: "string",
                repeatable: true,
                description: "A number the run produced, as key=value (repeatable)",
              },
              artifact: {
                type: "string",
                repeatable: true,
                description: "A file or URL the run left behind (repeatable)",
              },
              outcome: {
                type: "string",
                description: "success (default), failure, or aborted",
              },
              note: { type: "string", description: "What this run was for" },
              narrative: {
                type: "string",
                description: "Attach to this narrative instead of the sole open one",
              },
            },
            async action({ args, options }) {
              const list = (raw: unknown): string[] =>
                raw
                  ? (Array.isArray(raw) ? (raw as string[]) : [raw as string])
                      .map((value) => value.trim())
                      .filter(Boolean)
                  : [];
              await runLogCommand(getWorker(), args.name, {
                params: list(options.param),
                metrics: list(options.metric),
                artifacts: list(options.artifact),
                note: options.note as string | undefined,
                outcome: options.outcome as string | undefined,
                narrative: options.narrative as string | undefined,
              });
            },
          }),
          ls: defineCommand({
            name: "ls",
            description: "List recorded runs, newest first",
            options: {
              name: { type: "string", description: "Only runs with this name" },
              since: { type: "string", description: "Window: 2w, 3d, 12h, or an ISO date" },
              limit: { type: "number", description: "Maximum runs to show (default 50)" },
            },
            async action({ options }) {
              await runListCommand(getWorker(), {
                name: options.name as string | undefined,
                since: parseSince(options.since as string | undefined),
                limit: options.limit as number | undefined,
              });
            },
          }),
          show: defineCommand({
            name: "show",
            description: "Show one run with its provenance",
            arguments: {
              id: { type: "string", required: true, description: "Run ID" },
            },
            async action({ args }) {
              await runShowCommand(getWorker(), args.id);
            },
          }),
        },
      }),
      kpi: defineCommand({
        name: "kpi",
        description: "Track progress metrics as a timeseries with goals",
        subcommands: {
          log: defineCommand({
            name: "log",
            description: "Record a KPI reading (creates the KPI on first use with --direction)",
            arguments: {
              name: { type: "string", required: true, description: "KPI name" },
              value: { type: "number", required: true, description: "Measured value" },
            },
            options: {
              direction: {
                type: "string",
                description: "Which way is better: up|down (required on first log)",
              },
              unit: { type: "string", description: "Unit label, e.g. ms, %, auc" },
              note: { type: "string", description: "What this KPI measures" },
              narrative: {
                type: "string",
                description: "Attach to this narrative (default: the sole open one)",
              },
              meta: {
                type: "string",
                repeatable: true,
                description: "Extra key=value dimension (repeatable)",
              },
            },
            async action({ args, options }) {
              await kpiLogCommand(getWorker(), args.name, args.value, {
                direction: parseKpiDirection(options.direction as string | undefined),
                unit: options.unit as string | undefined,
                note: options.note as string | undefined,
                narrative: options.narrative as string | undefined,
                meta:
                  options.meta === undefined
                    ? undefined
                    : ([] as string[]).concat(options.meta as string | string[]),
              });
            },
          }),
          goal: defineCommand({
            name: "goal",
            description: "Set (or replace) the target for a KPI",
            arguments: {
              name: { type: "string", required: true, description: "KPI name" },
              target: { type: "number", required: true, description: "Target value" },
            },
            options: {
              direction: {
                type: "string",
                description: "Which way is better: up|down (required on first use)",
              },
              unit: { type: "string", description: "Unit label" },
              note: { type: "string", description: "What this KPI measures" },
            },
            async action({ args, options }) {
              await kpiGoalCommand(getWorker(), args.name, args.target, {
                direction: parseKpiDirection(options.direction as string | undefined),
                unit: options.unit as string | undefined,
                note: options.note as string | undefined,
              });
            },
          }),
          status: defineCommand({
            name: "status",
            description: "Show KPIs: latest value, delta, gap to goal (with history for one KPI)",
            arguments: {
              name: { type: "string", description: "KPI name (omit for all)" },
            },
            options: {
              limit: { type: "number", description: "Readings to show for one KPI (default 10)" },
            },
            async action({ args, options }) {
              await kpiStatusCommand(
                getWorker(),
                args.name as string | undefined,
                options.limit as number | undefined,
              );
            },
          }),
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
        async action({ args }) {
          await registerCommand(getWorker(), args.path, args.name);
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
      rebuild: defineCommand({
        name: "rebuild",
        description: "Rewrite a concept body from its journal entries and bindings",
        arguments: {
          concept: { type: "string", required: true, description: "Concept name" },
        },
        async action({ args }) {
          await conceptRebuildCommand(getWorker(), args.concept);
        },
      }),
      close: defineCommand({
        name: "close",
        description: "Queue a narrative close (merge) or discard it",
        arguments: {
          narrative: { type: "string", required: true, description: "Narrative name" },
        },
        options: {
          mode: { type: "string", description: "merge (default) or discard" },
          wait: { type: "boolean", description: "Block until the close job finishes" },
          "poll-ms": { type: "number", description: "Polling interval for --wait in milliseconds" },
          "merge-strategy": {
            type: "string",
            description:
              "patch (default, keeps the text the entries do not touch), extend (adds only), correct (drops claims the entries do not support), replace (writes a new body from the entries)",
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
          const result = await closeCommand(
            getWorker(),
            args.narrative,
            mode,
            mergeStrategy,
            options["from-result"] as string | undefined,
            {
              wait: Boolean(options.wait),
              pollMs: options["poll-ms"] as number | undefined,
            },
          );
        },
      }),
      jobs: defineCommand({
        name: "jobs",
        description: "List recent daemon jobs",
        options: {
          limit: { type: "number", description: "Maximum jobs to show" },
          type: {
            type: "string",
            description: "Filter to close, ingest, or rebuild jobs",
          },
        },
        async action({ options }) {
          const type = options.type as "close" | "ingest" | "rebuild" | undefined;
          if (type && type !== "close" && type !== "ingest" && type !== "rebuild") {
            throw new Error("Job type must be one of: close, ingest, rebuild");
          }
          await closeJobsCommand(getWorker(), {
            limit: options.limit as number | undefined,
            type,
          });
        },
      }),
      job: defineCommand({
        name: "job",
        description: "Inspect one daemon job",
        arguments: {
          id: { type: "string", required: true, description: "Job ID" },
        },
        async action({ args }) {
          await closeJobCommand(getWorker(), args.id);
        },
      }),
      wait: defineCommand({
        name: "wait",
        description: "Wait for a daemon job to finish",
        arguments: {
          id: { type: "string", required: true, description: "Job ID" },
        },
        options: {
          "poll-ms": { type: "number", description: "Polling interval in milliseconds" },
        },
        async action({ args, options }) {
          await waitCommand(getWorker(), args.id, {
            pollMs: options["poll-ms"] as number | undefined,
          });
        },
      }),
      usage: defineCommand({
        name: "usage",
        description: "Show what this lore has spent on AI calls",
        options: {
          since: { type: "string", description: "Window: 2w, 3d, 12h, or an ISO date" },
          by: { type: "string", description: "Group by: model (default), operation, or kind" },
          all: { type: "boolean", description: "Every registered lore, not just this one" },
        },
        async action({ options }) {
          await usageCommand(getWorker(), {
            since: options.since,
            by: options.by,
            all: options.all,
          });
        },
      }),
      ingest: defineCommand({
        name: "ingest",
        description:
          "Index the codebase — scan code and ingest docs. Pass a file path to ingest a single document.",
        arguments: {
          file: { type: "string", required: false, description: "Specific file to ingest" },
        },
        options: {
          force: {
            type: "boolean",
            description: "Re-chunk every file, ignoring the unchanged-content check",
          },
          // Named for what it does, not for what it skips. commander reads a
          // `--no-x` flag as the negation of `x` and inverts the value, so a
          // `--no-wait` here would arrive true when it was never passed.
          queue: {
            type: "boolean",
            description: "Queue the ingest and return, instead of waiting for it",
          },
        },
        async action({ args, options }) {
          const file = args.file as string | undefined;
          if (options.queue) {
            if (file) {
              throw new Error("--queue ingests the whole project, so it takes no file argument.");
            }
            await queueIngestAllCommand(getWorker(), {
              force: options.force as boolean | undefined,
            });
            return;
          }
          if (file) {
            await ingestFileCommand(getWorker(), file);
          } else {
            await ingestAllCommand(getWorker(), { force: options.force as boolean | undefined });
          }
        },
      }),
      daemon: defineCommand({
        name: "daemon",
        description: "Manage the local Lore daemon",
        subcommands: {
          start: defineCommand({
            name: "start",
            description: "Start the local Lore daemon",
            async action() {
              await daemonStartCommand();
            },
          }),
          status: defineCommand({
            name: "status",
            description: "Show Lore daemon status",
            async action() {
              await daemonStatusCommand();
            },
          }),
          stop: defineCommand({
            name: "stop",
            description: "Stop the local Lore daemon",
            async action() {
              await daemonStopCommand();
            },
          }),
          logs: defineCommand({
            name: "logs",
            description: "Show recent Lore daemon logs",
            options: {
              lines: { type: "number", description: "Number of lines to show" },
            },
            async action({ options }) {
              await daemonLogsCommand((options.lines as number | undefined) ?? 100);
            },
          }),
          serve: defineCommand({
            name: "serve",
            description: "Internal daemon entrypoint",
            options: {
              socket: { type: "string", description: "Socket path override" },
              db: { type: "string", description: "Queue DB path override" },
              log: { type: "string", description: "Log path override" },
            },
            async action({ options }) {
              await serveLoreDaemon({
                socket: options.socket as string | undefined,
                db: options.db as string | undefined,
                log: options.log as string | undefined,
              });
            },
          }),
        },
      }),
      skill: defineCommand({
        name: "skill",
        description: "Manage the agent skill this lore carries",
        subcommands: {
          install: defineCommand({
            name: "install",
            description: "Install the skill for Claude Code",
            options: {
              agent: {
                type: "string",
                description: "Install for this agent (repeatable). Default: claude-code",
                repeatable: true,
              },
              project: {
                type: "boolean",
                description: "Install into this project, not the home directory",
              },
              link: {
                type: "boolean",
                description: "Link from this binary instead of calling the skills CLI",
              },
              dir: {
                type: "string",
                description: "Install somewhere other than ~/.claude/skills/lore",
              },
              copy: { type: "boolean", description: "Write a copy instead of a link" },
              force: { type: "boolean", description: "Replace whatever sits at the target" },
            },
            action({ options }) {
              const agents = (options.agent as string[] | string | undefined) ?? [];
              const agentList = Array.isArray(agents) ? agents : [agents];

              // --dir, --link and --copy each name a path the skills CLI does
              // not take, so they keep the install inside this binary.
              const wantsBuiltIn =
                Boolean(options.link) || Boolean(options.copy) || options.dir !== undefined;

              if (!wantsBuiltIn) {
                if (npxAvailable()) {
                  const result = installWithNpx({
                    agents: agentList,
                    project: Boolean(options.project),
                  });
                  console.log(result.message);
                  if (!result.ok) process.exitCode = 1;
                  return;
                }
                console.log("npx is not available — linking from this binary instead.");
              } else if (agentList.length > 0 || options.project) {
                console.log(
                  "--agent and --project need the skills CLI. Drop --link, --copy and --dir.",
                );
                process.exitCode = 1;
                return;
              }

              const result = installSkill({
                dir: options.dir as string | undefined,
                copy: Boolean(options.copy),
                force: Boolean(options.force),
              });
              console.log(result.message);
              if (!result.ok) process.exitCode = 1;
            },
          }),
          status: defineCommand({
            name: "status",
            description: "Show where the skill is, and whether it follows this lore",
            options: {
              dir: {
                type: "string",
                description: "Check somewhere other than ~/.claude/skills/lore",
              },
            },
            action({ options }) {
              for (const line of describeSkill({ dir: options.dir as string | undefined })) {
                console.log(line);
              }
            },
          }),
          uninstall: defineCommand({
            name: "uninstall",
            description: "Remove the installed skill",
            options: {
              dir: {
                type: "string",
                description: "Remove from somewhere other than ~/.claude/skills/lore",
              },
            },
            action({ options }) {
              const result = uninstallSkill({ dir: options.dir as string | undefined });
              console.log(result.message);
              if (!result.ok) process.exitCode = 1;
            },
          }),
        },
      }),
      upgrade: defineCommand({
        name: "upgrade",
        description: "Install the latest release over this one",
        async action() {
          const result = await runUpgrade(getVersionString().split(" ")[0] ?? "0.0.0");
          if (!result.ok) {
            console.log(result.reason);
            return;
          }
          console.log(`\nlore is now v${result.version}.`);
        },
      }),
      sys: defineCommand({
        name: "sys",
        description: "System administration for the current lore",
        subcommands: {
          hooks: defineCommand({
            name: "hooks",
            description: "Manage the git hook that keeps the index fresh",
            subcommands: {
              install: defineCommand({
                name: "install",
                description: "Write a post-commit hook that queues an ingest",
                options: {
                  force: {
                    type: "boolean",
                    description: "Replace a post-commit hook lore did not write",
                  },
                },
                action({ options }) {
                  const result = installHook({ force: Boolean(options.force) });
                  switch (result.kind) {
                    case "installed":
                      console.log(`Installed the post-commit hook.\n  ${result.path}`);
                      return;
                    case "updated":
                      console.log(`Updated the post-commit hook.\n  ${result.path}`);
                      return;
                    case "unchanged":
                      console.log(`Already installed.\n  ${result.path}`);
                      return;
                    case "occupied":
                      console.log(
                        [
                          "A post-commit hook is already there, and lore did not write it.",
                          `  ${result.path}`,
                          "Add this line to it, or pass --force to replace it:",
                          `  ${manualHookLine()}`,
                        ].join("\n"),
                      );
                      process.exitCode = 1;
                      return;
                    case "shared":
                      console.log(
                        [
                          `core.hooksPath is ${result.hooksPath}, outside this repository.`,
                          "git runs that directory for every repository that reads this",
                          "config, so lore does not write there. Add this line to its",
                          "post-commit hook:",
                          `  ${manualHookLine()}`,
                        ].join("\n"),
                      );
                      process.exitCode = 1;
                      return;
                    case "not-a-repo":
                      console.log("Not a git repository.");
                      process.exitCode = 1;
                  }
                },
              }),
              status: defineCommand({
                name: "status",
                description: "Show whether the hook is installed",
                action() {
                  for (const line of describeHook()) console.log(line);
                },
              }),
              uninstall: defineCommand({
                name: "uninstall",
                description: "Remove the post-commit hook lore wrote",
                action() {
                  const result = uninstallHook();
                  switch (result.kind) {
                    case "removed":
                      console.log(`Removed the post-commit hook.\n  ${result.path}`);
                      return;
                    case "absent":
                      console.log("No lore hook to remove.");
                      return;
                    case "foreign":
                      console.log(
                        [
                          "The post-commit hook there was not written by lore, so it stays.",
                          `  ${result.path}`,
                        ].join("\n"),
                      );
                      process.exitCode = 1;
                      return;
                    case "shared":
                      console.log(
                        `core.hooksPath is ${result.hooksPath}, outside this repository. lore wrote nothing there.`,
                      );
                      process.exitCode = 1;
                      return;
                    case "not-a-repo":
                      console.log("Not a git repository.");
                      process.exitCode = 1;
                  }
                },
              }),
            },
          }),
          worker: defineCommand({
            name: "worker",
            description: "Ask the daemon to drain queued close jobs",
            options: {
              once: { type: "boolean", description: "Run until the queue is empty, then exit" },
              watch: { type: "boolean", description: "Keep polling for new jobs" },
              "poll-ms": { type: "number", description: "Polling interval in milliseconds" },
            },
            async action({ options }) {
              const watch = Boolean(options.watch) && !options.once;
              await workerCommand(getWorker(), {
                watch,
                pollMs: options["poll-ms"] as number | undefined,
              });
            },
          }),
          "update-check": defineCommand({
            name: "update-check",
            description: "Refresh the cached latest release",
            options: {
              refresh: { type: "boolean", description: "Read GitHub and write the cache" },
            },
            async action() {
              const latest = await refreshUpdateCache();
              if (!latest) {
                console.log("Could not reach GitHub.");
                return;
              }
              console.log(latest);
            },
          }),
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
            async action({ options }) {
              await coverageCommand(getWorker(), {
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
                  recompute: {
                    type: "boolean",
                    description: "Recompute signals before explaining",
                  },
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
                  file: {
                    type: "string",
                    description: "File holding the symbol, when the name is not unique",
                  },
                },
                async action({ args, options }) {
                  await conceptBindCommand(
                    getWorker(),
                    args.concept,
                    args.symbol,
                    options.confidence as number | undefined,
                    options.file as string | undefined,
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
                options: {
                  file: {
                    type: "string",
                    description: "File holding the symbol, when the name is bound more than once",
                  },
                  line: {
                    type: "number",
                    description: "First line of the symbol, when one file declares the name twice",
                  },
                },
                async action({ args, options }) {
                  await conceptUnbindCommand(
                    getWorker(),
                    args.concept,
                    args.symbol,
                    options.file as string | undefined,
                    options.line as number | undefined,
                  );
                },
              }),
            },
          }),
          narrative: defineCommand({
            name: "narrative",
            description: "Narrative repair and maintenance commands",
            subcommands: {
              designate: defineCommand({
                name: "designate",
                description: "Set explicit concept designations on a journal entry by chunk ID",
                arguments: {
                  narrative: { type: "string", required: true, description: "Open narrative name" },
                  chunk: { type: "string", required: true, description: "Journal chunk ID" },
                },
                options: {
                  concept: {
                    type: "string",
                    repeatable: true,
                    description:
                      "Concept designation (repeatable). Required unless the narrative has exactly one create/update target.",
                  },
                },
                async action({ args, options }) {
                  const concepts = options.concept
                    ? (Array.isArray(options.concept)
                        ? (options.concept as string[])
                        : [options.concept as string]
                      )
                        .map((concept: string) => concept.trim())
                        .filter(Boolean)
                    : [];
                  await narrativeDesignateCommand(getWorker(), args.narrative, args.chunk, {
                    concepts,
                  });
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
          prune: defineCommand({
            name: "prune",
            description: "Delete rows left behind by replaced chunks, then reclaim disk",
            options: {
              dry: { type: "boolean", description: "Count only (no changes)" },
            },
            async action({ options }) {
              await systemPruneCommand(getWorker(), options.dry);
            },
          }),
          vacuum: defineCommand({
            name: "vacuum",
            description: "Rewrite the database file without its free pages",
            async action() {
              await systemVacuumCommand(getWorker());
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
              models: defineCommand({
                name: "models",
                description:
                  "List the models a provider offers. Omit the provider to search all configured ones.",
                arguments: {
                  provider: { type: "string", description: "Provider name" },
                },
                options: {
                  search: { type: "string", description: "Filter by substring in the model id" },
                  sort: { type: "string", description: "Sort by: id (default), price, or context" },
                  type: {
                    type: "string",
                    description: "Keep one kind: generation, embedding, or other",
                  },
                  "all-kinds": {
                    type: "boolean",
                    description: "Include kinds lore cannot use (video, image, speech)",
                  },
                  limit: { type: "number", description: "Models per page (default: 30)" },
                  page: { type: "number", description: "Page number (default: 1)" },
                },
                async action({ args, options }) {
                  await providerModelsCommand(getWorker(), args.provider, {
                    search: options.search,
                    sort: options.sort,
                    type: options.type,
                    allKinds: options["all-kinds"],
                    limit: options.limit,
                    page: options.page,
                  });
                },
              }),
              usage: defineCommand({
                name: "usage",
                description: "Show a provider's credit balance and spend",
                arguments: {
                  provider: { type: "string", required: true, description: "Provider name" },
                },
                async action({ args }) {
                  await providerUsageCommand(getWorker(), args.provider);
                },
              }),
              use: defineCommand({
                name: "use",
                description: "Point this lore at a provider and model",
                arguments: {
                  provider: { type: "string", required: true, description: "Provider name" },
                  model: { type: "string", required: true, description: "Model id" },
                },
                options: {
                  embedding: {
                    type: "boolean",
                    description: "Set the embedding role instead of generation",
                  },
                  dim: {
                    type: "number",
                    description:
                      "Vector size of the new embedding model (required with --embedding)",
                  },
                  // Not "no-verify": Commander reads a --no-x flag as the negation
                  // of x, so its value defaults to true and the meaning inverts.
                  scope: {
                    type: "string",
                    description:
                      "Where to write: project (default, this repo) or global (every lore)",
                  },
                  "skip-verify": {
                    type: "boolean",
                    description: "Skip checking the model against the provider's catalog",
                  },
                },
                async action({ args, options }) {
                  await providerUseCommand(getWorker(), args.provider, args.model, {
                    embedding: options.embedding,
                    dim: options.dim,
                    noVerify: options["skip-verify"],
                    scope: options.scope,
                  });
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
      handleCliError(error, exit);
    },
  });

  return buildCommanderCli(spec);
}

/**
 * Print the update notice, when there is one.
 *
 * The notice reads a cache, so it adds no delay. It stays off the output of
 * `--json`, of a pipe, and of a build machine, because each of those reads the
 * output by machine. The refresh command prints its own result.
 */
function printUpdateNotice(argv: string[]): void {
  if (argv[0] === "upgrade" || argv.includes("update-check")) return;
  if (!isInteractiveOutputEnabled()) return;
  const notice = updateNotice(getVersionString().split(" ")[0] ?? "0.0.0");
  if (notice) console.log(`\n${notice}`);
}

export async function runLoreCli(argv: string[], deps: LoreCliDeps = {}): Promise<void> {
  setJsonOutput(argv.includes("--json") || argv.includes("-j"));
  const cli = createLoreCli(deps);
  const exit =
    deps.exit ??
    ((code: number): never => {
      process.exit(code);
    });
  if (argv.length === 0) {
    cli.outputHelp();
    printUpdateNotice(argv);
    return;
  }
  try {
    await cli.parseAsync(argv, { from: "user" });
    printUpdateNotice(argv);
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error.code === "commander.helpDisplayed" || error.code === "commander.version")
    ) {
      // Commander reports help and --version by throwing. Both still deserve
      // the notice, because both are where a user looks for the version.
      printUpdateNotice(argv);
      return;
    }
    handleCliError(error, exit);
  }
}
