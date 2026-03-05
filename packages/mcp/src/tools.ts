import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RelationType, WorkerClient, NarrativeTarget, MergeStrategy } from "@lore/worker";
import { renderLs, renderStatus } from "@lore/rendering";
import {
  formatOpen,
  formatLog,
  formatAskMcpBrief,
  formatRecallMcp,
  formatClose,
  formatCommitLog,
  formatNarrativeTrail,
  formatDryRunClose,
  formatHistory,
  formatLifecycleResult,
  formatShow,
  formatRelationsMcp,
  formatBindingsMcp,
  formatSuggest,
  formatTreeDiff,
  formatConfigCurated,
  formatConfigGet,
  formatConfigSet,
  type RecallSection,
} from "./formatters.ts";

const narrativeTargetSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("create"), concept: z.string() }),
  z.object({ op: z.literal("update"), concept: z.string() }),
  z.object({ op: z.literal("archive"), concept: z.string(), reason: z.string().optional() }),
  z.object({ op: z.literal("restore"), concept: z.string() }),
  z.object({ op: z.literal("rename"), from: z.string(), to: z.string() }),
  z.object({
    op: z.literal("merge"),
    source: z.string(),
    into: z.string(),
    reason: z.string().optional(),
  }),
  z.object({ op: z.literal("split"), concept: z.string(), parts: z.number().optional() }),
]);

export function registerTools(server: McpServer, client: WorkerClient): void {
  server.tool(
    "open",
    "Open a new narrative for exploration",
    {
      narrative: z.string().describe("Kebab-case narrative name"),
      intent: z.string().describe("What you intend to explore"),
      resolve_dangling: z
        .object({
          narrative: z.string(),
          action: z.enum(["resume", "close", "abandon"]),
        })
        .optional()
        .describe("Resolve a dangling narrative before opening"),
      targets: z
        .array(narrativeTargetSchema)
        .optional()
        .describe(
          "Declare which concepts this narrative will affect. create/update: on close, integration only routes journal entries to these concepts. lifecycle (archive, rename, merge, split, restore): these operations execute automatically when the narrative closes.",
        ),
    },
    async ({ narrative, intent, resolve_dangling, targets }) => {
      const result = await client.open(narrative, intent, {
        resolveDangling: resolve_dangling,
        targets: targets as NarrativeTarget[] | undefined,
      });
      return { content: [{ type: "text" as const, text: formatOpen(result) }] };
    },
  );

  const writeArgs = {
    narrative: z.string().describe("Name of the open narrative"),
    entry: z.string().describe("Journal entry content"),
    concepts: z
      .array(z.string())
      .min(1)
      .describe(
        "Concept names this entry updates. Must exist in the lore (or will be created at close time). Bypasses LLM routing for these entries.",
      ),
    symbols: z
      .array(z.string())
      .optional()
      .describe(
        "Symbol names from the scanned codebase. Resolved to file:line automatically from the symbol index and auto-bound to assigned concept.",
      ),
    refs: z
      .array(
        z.object({
          path: z.string().describe("File path relative to lore root"),
          lines: z.tuple([z.number(), z.number()]).optional().describe("Line range [start, end]"),
        }),
      )
      .optional()
      .describe("File references for non-indexed files (SQL migrations, configs, etc.). Use symbols instead for TS/JS/Python/Go/Rust code."),
  };

  const writeHandler = async ({
    narrative,
    entry,
    concepts,
    symbols,
    refs,
  }: {
    narrative: string;
    entry: string;
    concepts: string[];
    symbols?: string[];
    refs?: Array<{ path: string; lines?: [number, number] }>;
  }) => {
    const result = await client.log(narrative, entry, { concepts, symbols, refs });
    return { content: [{ type: "text" as const, text: formatLog(result) }] };
  };

  server.tool("write", "Write a journal entry to an open narrative", writeArgs, writeHandler);
  server.tool(
    "append",
    "Alias of write: append a journal entry to an open narrative",
    writeArgs,
    writeHandler,
  );

  server.tool(
    "ask",
    "Ask a question of the lore",
    {
      query: z.string().describe("Query text"),
      mode: z
        .enum(["arch", "code"])
        .optional()
        .describe(
          "Retrieval mode. 'code' injects bound symbol source bodies alongside concept prose — use when asking about specific function/class implementations. 'arch' (default) returns concept prose only — use for architectural, design, or process questions.",
        ),
    },
    async ({ query, mode }) => {
      const result = await client.query(query, { mode });
      const text = formatAskMcpBrief(result);
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  server.tool(
    "recall",
    "Retrieve a cached query result by ID for detailed inspection",
    {
      result_id: z.string().describe("Result ID from a previous ask call"),
      section: z
        .enum(["sources", "journal", "symbols", "full"])
        .optional()
        .describe("Which section to return (default: full)"),
    },
    async ({ result_id, section }) => {
      const recalled = client.recall(result_id);
      if (!recalled) {
        return {
          content: [{ type: "text" as const, text: `No cached result found for ID: ${result_id}` }],
        };
      }
      return {
        content: [
          {
            type: "text" as const,
            text: formatRecallMcp(recalled, (section ?? "full") as RecallSection),
          },
        ],
      };
    },
  );

  server.tool(
    "score",
    "Rate the quality of a previous ask result",
    {
      result_id: z.string().describe("Result ID from a previous ask call"),
      score: z.number().int().min(1).max(5).describe("Quality score (1-5)"),
    },
    async ({ result_id, score }) => {
      try {
        client.scoreResult(result_id, score);
        return {
          content: [{ type: "text" as const, text: `Scored result ${result_id}: ${score}/5` }],
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: `No cached result found for ID: ${result_id}` }],
        };
      }
    },
  );

  server.tool(
    "close",
    "Close a narrative — merge (default) integrates findings, discard abandons without integrating",
    {
      narrative: z.string().describe("Name of the narrative to close"),
      mode: z
        .enum(["merge", "discard"])
        .default("merge")
        .describe("merge to integrate, discard to abandon"),
      mergeStrategy: z
        .enum(["replace", "extend", "patch", "correct"])
        .default("replace")
        .optional()
        .describe(
          "How to update existing concept content. replace (default): regenerate entire concept, preserving sections not touched by this narrative. extend: keep all existing content, append new sections from this narrative's journal. patch: minimal paragraph-level edits only. correct: journal entries are authoritative; discard existing content not confirmed by journal — use when the concept contains wrong information.",
        ),
      dry_run: z
        .boolean()
        .optional()
        .describe("Preview what close would do without actually closing the narrative"),
    },
    async ({ narrative, mode, mergeStrategy, dry_run }) => {
      if (dry_run) {
        const result = await client.dryRunClose(narrative);
        return { content: [{ type: "text" as const, text: formatDryRunClose(result) }] };
      }
      const result = await client.close(narrative, {
        mode,
        mergeStrategy: mergeStrategy as MergeStrategy | undefined,
      });
      return { content: [{ type: "text" as const, text: formatClose(result) }] };
    },
  );

  server.tool(
    "patch",
    "Apply a maintenance patch to an active concept",
    {
      concept: z.string().describe("Concept name"),
      text: z.string().describe("New content for the concept"),
      topics: z.array(z.string()).optional().describe("Related topic keywords"),
      direct: z
        .boolean()
        .optional()
        .describe(
          "Write text verbatim without LLM integration (default: false). Use direct=true when you know the exact content; omit to let the LLM intelligently merge your text with existing content.",
        ),
    },
    async ({ concept, text, topics, direct }) => {
      const result = await client.conceptPatch(concept, text, { topics, direct });
      return { content: [{ type: "text" as const, text: formatLifecycleResult(result) }] };
    },
  );

  server.tool(
    "relate",
    "Set or remove a directed relation between two concepts",
    {
      from: z.string().describe("Source concept name"),
      to: z.string().describe("Target concept name"),
      type: z.enum(["depends_on", "constrains", "implements", "uses", "related_to"]),
      weight: z.number().min(0).max(1).optional().describe("Relation strength [0–1], default 1.0"),
      remove: z.boolean().optional().describe("Remove this relation instead of setting it"),
    },
    async ({ from, to, type, weight, remove }) => {
      if (remove) {
        const result = client.unsetConceptRelation(from, to, {
          relationType: type as RelationType,
        });
        const count = Array.isArray(result) ? result.length : 1;
        return { content: [{ type: "text" as const, text: `Removed ${count} relation(s).` }] };
      }
      client.setConceptRelation(from, to, type as RelationType, { weight });
      return { content: [{ type: "text" as const, text: `${from} → ${to} [${type}]` }] };
    },
  );

  server.tool("status", "Get system health and lore status", {}, async () => {
    const result = await client.status();
    return { content: [{ type: "text" as const, text: renderStatus(result, { route: "mcp" }) }] };
  });

  server.tool(
    "suggest",
    "Get a prioritized, step-by-step healing plan for the lore",
    {
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum suggestions to return (default: 10)"),
      kind: z
        .enum([
          "merge",
          "relate",
          "close-narrative",
          "abandon-narrative",
          "clean-relation",
          "symbol-drift",
          "coverage-gap",
          "review",
          "cluster-drift",
          "archive",
        ])
        .optional()
        .describe("Filter suggestions by kind"),
    },
    async ({ limit, kind }) => {
      const result = await client.suggest({ limit, kind });
      return { content: [{ type: "text" as const, text: formatSuggest(result) }] };
    },
  );

  server.tool(
    "ls",
    "List all concepts with residuals, staleness, clusters, and active narratives",
    {},
    async () => {
      const result = await client.ls();
      return { content: [{ type: "text" as const, text: renderLs(result, { route: "mcp" }) }] };
    },
  );

  server.tool(
    "show",
    "Show the current content of a concept, optionally at a historical commit ref",
    {
      concept: z.string().describe("Concept name"),
      ref: z.string().optional().describe("Historical commit ref (e.g., main~3)"),
    },
    async ({ concept, ref }) => {
      const result = await client.show(concept, { ref });
      const relations = client.listConceptRelations({ concept });
      const bindings = client.conceptBindings(concept);
      const relText = formatRelationsMcp(relations, concept);
      const bindText = formatBindingsMcp(bindings);
      let text = formatShow(concept, result);
      if (relText) text += "\n\n" + relText;
      if (bindText) text += "\n\n" + bindText;
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "trail",
    "Show all journal entries for a named narrative — reconstructs the full investigation trail",
    {
      narrative: z.string().describe("Narrative name"),
    },
    async ({ narrative }) => {
      const result = await client.showNarrativeTrail(narrative);
      return { content: [{ type: "text" as const, text: formatNarrativeTrail(result) }] };
    },
  );

  server.tool(
    "bind",
    "Bind or unbind a source symbol to a concept",
    {
      concept: z.string().describe("Concept name"),
      symbol: z.string().describe("Symbol qualified name (e.g., MyClass.myMethod)"),
      remove: z.boolean().optional().describe("Remove this binding instead of setting it"),
      confidence: z
        .number()
        .min(0)
        .max(1)
        .optional()
        .describe("Binding confidence [0–1], default 1.0"),
    },
    async ({ concept, symbol, remove, confidence }) => {
      if (remove) {
        const result = client.unbindSymbol(concept, symbol);
        return {
          content: [
            {
              type: "text" as const,
              text: result.removed
                ? `Removed binding: ${concept} ↔ ${symbol}`
                : `No binding found for ${concept} ↔ ${symbol}`,
            },
          ],
        };
      }
      const binding = client.bindSymbol(concept, symbol, { confidence });
      return {
        content: [
          {
            type: "text" as const,
            text: `Bound ${binding.symbol_name} (${binding.symbol_kind}) → ${concept} [${binding.binding_type}, confidence: ${binding.confidence.toFixed(2)}]`,
          },
        ],
      };
    },
  );

  server.tool(
    "history",
    "Version history and commits for a concept",
    {
      concept: z.string().describe("Concept name"),
    },
    async ({ concept }) => {
      const result = await client.history(concept);
      return { content: [{ type: "text" as const, text: formatHistory(concept, result) }] };
    },
  );

  server.tool(
    "archive",
    "Archive an active concept (removes from current truth)",
    {
      concept: z.string().describe("Concept name"),
      reason: z.string().optional().describe("Reason for archiving"),
    },
    async ({ concept, reason }) => {
      const result = await client.conceptArchive(concept, { reason });
      return { content: [{ type: "text" as const, text: formatLifecycleResult(result) }] };
    },
  );

  server.tool(
    "rename",
    "Rename an active concept",
    {
      from: z.string().describe("Current concept name"),
      to: z.string().describe("New concept name"),
    },
    async ({ from, to }) => {
      const result = await client.conceptRename(from, to);
      return { content: [{ type: "text" as const, text: formatLifecycleResult(result) }] };
    },
  );

  server.tool(
    "merge",
    "Merge one concept into another",
    {
      source: z.string().describe("Concept to merge from (will be archived)"),
      into: z.string().describe("Concept to merge into (will be updated)"),
      reason: z.string().optional().describe("Reason for merging"),
      preview: z.boolean().optional().describe("Preview the merge without applying it"),
    },
    async ({ source, into, reason, preview }) => {
      const result = await client.conceptMerge(source, into, { reason, preview });
      return { content: [{ type: "text" as const, text: formatLifecycleResult(result) }] };
    },
  );

  server.tool(
    "diff",
    "Compare two commit refs to see what changed between them",
    {
      from_ref: z.string().describe("Starting commit ref (e.g., main~3, 2w, 3d, 12h, ULID, main@2024-01-01)"),
      to_ref: z.string().describe("Ending commit ref (e.g., main, 1w, ULID)"),
      page: z.number().int().min(1).optional().describe("Page number for paginated results (default: 1)"),
      page_size: z.number().int().min(1).max(20).optional().describe("Changes per page (default: 5)"),
    },
    async ({ from_ref, to_ref, page, page_size }) => {
      const diff = await client.diffCommits(from_ref, to_ref, { includeContent: true });
      return { content: [{ type: "text" as const, text: formatTreeDiff(diff, { page, pageSize: page_size }) }] };
    },
  );

  server.tool(
    "log",
    "Walk commit history showing narrative intents, lifecycle events, and affected concepts",
    {
      limit: z.number().int().min(1).optional().describe("Maximum commits to return (default: 20)"),
      since: z.string().optional().describe("Time filter: duration shorthand (2w, 3d, 12h, 30m), ULID, or main~N"),
    },
    async ({ limit, since }) => {
      const entries = client.commitLog({ limit: limit ?? 20, since });
      return { content: [{ type: "text" as const, text: formatCommitLog(entries) }] };
    },
  );

  server.tool(
    "config",
    "Read or write per-lore config. No args = curated view. key only = get that path. key + value = set.",
    {
      key: z.string().optional().describe("Dotted config path, e.g. ai.generation.model"),
      value: z
        .union([z.string(), z.number(), z.boolean()])
        .optional()
        .describe("Value to set (omit to read)"),
    },
    async ({ key, value }) => {
      const { config: overrides, resolved } = client.getLoreMindConfig();

      if (!key) {
        const text = formatConfigCurated(resolved, overrides);
        return { content: [{ type: "text" as const, text }] };
      }

      if (value === undefined) {
        const text = formatConfigGet(key, resolved, overrides);
        return { content: [{ type: "text" as const, text }] };
      }

      client.setLoreMindConfig(key, value);
      const text = formatConfigSet(key, value);
      return { content: [{ type: "text" as const, text }] };
    },
  );

  server.tool(
    "ingest",
    "Index the codebase — scans code symbols and ingests docs/configs in parallel. Pass a file path to ingest a single document.",
    {
      path: z.string().optional().describe("Specific file path to ingest. Omit to index everything (code scan + doc ingest)."),
    },
    async ({ path }) => {
      if (path) {
        const result = await client.ingestDoc(path);
        const status = result.files_ingested > 0 ? "Ingested" : "Skipped (unchanged)";
        return { content: [{ type: "text" as const, text: status }] };
      } else {
        const { scan, ingest } = await client.ingestAll();
        const langs = Object.entries(scan.languages)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ");
        const lines = [
          `Code:  ${scan.files_scanned} files scanned, ${scan.symbols_found} symbols (${langs})`,
          `Docs:  ${ingest.files_ingested} files ingested, ${ingest.files_skipped} skipped, ${ingest.files_removed} removed`,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") }] };
      }
    },
  );
}
