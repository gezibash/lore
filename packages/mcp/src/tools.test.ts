import { expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkerClient } from "@lore/worker";
import { registerTools } from "./tools.ts";

test("registerTools exposes canonical minimal MCP surface", () => {
  const names: string[] = [];
  const server = {
    tool(name: string) {
      names.push(name);
      return {};
    },
  } as unknown as McpServer;

  registerTools(server, {} as WorkerClient);

  const expected = [
    "open",
    "write",
    "append",
    "ask",
    "recall",
    "score",
    "close",
    "patch",
    "relate",
    "status",
    "suggest",
    "ls",
    "show",
    "trail",
    "bind",
    "history",
    "archive",
    "rename",
    "merge",
    "diff",
    "log",
    "config",
    "ingest",
  ];
  expect(names).toEqual(expected);

  for (const hidden of [
    "restore",
    "concept_rename",
    "concept_archive",
    "concept_restore",
    "concept_merge",
    "concept_split",
    "concept_patch",
  ]) {
    expect(names).not.toContain(hidden);
  }
});

test("ask tool returns brief summary with result_id", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const schemas = new Map<string, Record<string, unknown>>();
  const server = {
    tool(
      name: string,
      _description: string,
      schema: Record<string, unknown>,
      handler: (...args: any[]) => any,
    ) {
      schemas.set(name, schema);
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;

  const client = {
    query: async () => ({
      meta: {
        query: "q",
        generated_at: "2026-02-24T00:00:00.000Z",
        generated_in: "10ms",
        brief: false,
        scanned: {
          local_candidates: 1,
          returned_results: 1,
          return_limit: 20,
          vector_limit: 20,
          text_vector_candidates: 1,
          code_vector_candidates: 1,
          fused_candidates: 1,
          staleness_checks: 0,
          web_search_enabled: false,
          web_results: 0,
          journal_candidates: 0,
          journal_results: 0,
        },
        rerank: {
          enabled: false,
          attempted: false,
          applied: false,
          model: "rerank-v3.5",
          candidates: 1,
          reason: "disabled",
        },
        executive_summary: {
          enabled: true,
          attempted: true,
          generated: true,
          model: "qwen3:8b",
          model_id: "",
          reason: "ok",
          source_matches: 1,
          usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        },
        grounding: {
          enabled: true,
          attempted: true,
          exactness_detected: false,
          hits_total: 1,
          call_site_hits: 0,
          files_considered: 1,
          mode: "always-on",
          reason: "ok",
        },
        structural_boost: {
          enabled: false,
          symbols_matched: 0,
          concepts_boosted: 0,
          boost_map: {},
        },
      },
      executive_summary: {
        narrative: "Summary output",
        kind: "generated" as const,
        sources: [],
        citations: [],
        counts: { concepts: 1, files: 1, symbols: 0, journal_entries: 0 },
      },
      results: [
        {
          concept: "auth-model",
          content: "content",
          summary: "summary",
          meta: {
            chunk_id: "chunk-1",
            files: ["src/auth.ts"],
            score: 0.91,
            residual: 0.1,
            staleness: 0.1,
            symbol_drift: "none" as const,
            symbols_bound: 0,
            symbols_drifted: 0,
          },
        },
      ],
      web_results: [],
    }),
  } as unknown as WorkerClient;

  registerTools(server, client);
  const askSchema = schemas.get("ask");
  expect(askSchema).toBeDefined();
  expect("sources" in (askSchema as Record<string, unknown>)).toBe(false);

  const ask = handlers.get("ask");
  expect(ask).toBeDefined();

  const response = await ask!({ query: "q" });
  const text = response.content[0].text as string;
  expect(text).toContain("Summary output");
  expect(text).toContain("Based on");
  expect(text).not.toContain("## Sources");
});

test("trail tool calls showNarrativeTrail and returns formatted text", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = {
    tool(
      name: string,
      _description: string,
      _schema: Record<string, unknown>,
      handler: (...args: any[]) => any,
    ) {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;

  const client = {
    showNarrativeTrail: async (narrativeName: string) => ({
      narrative: {
        name: narrativeName,
        intent: "Debug auth perf",
        status: "closed",
        entry_count: 2,
        opened_at: "2026-02-25T10:00:00.000Z",
        closed_at: "2026-02-25T15:00:00.000Z",
      },
      entries: [
        {
          content: "First finding.",
          topics: ["auth"],
          status: "finding",
          created_at: "2026-02-25T11:00:00.000Z",
          position: 1,
        },
        {
          content: "Confirmed root cause.",
          topics: ["auth", "perf"],
          status: "confirmed",
          created_at: "2026-02-25T12:00:00.000Z",
          position: 2,
        },
      ],
      topics_covered: ["auth", "perf"],
    }),
  } as unknown as WorkerClient;

  registerTools(server, client);

  const trail = handlers.get("trail");
  expect(trail).toBeDefined();

  const response = await trail!({ narrative: "auth-debug" });
  const text = response.content[0].text as string;
  expect(text).toContain("## auth-debug");
  expect(text).toContain("Debug auth perf");
  expect(text).toContain("### Entry 1");
  expect(text).toContain("### Entry 2");
  expect(text).toContain("First finding.");
  expect(text).toContain("Confirmed root cause.");
});

test("config tool returns curated view with no args, gets specific key, and sets values", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const server = {
    tool(name: string, _d: string, _s: unknown, handler: (...args: any[]) => any) {
      handlers.set(name, handler);
      return {};
    },
  } as unknown as McpServer;

  const mockResolved = {
    lore_root: "/test",
    ai: {
      generation: { provider: "ollama", model: "qwen3:8b", api_key: undefined },
      embedding: { provider: "ollama", model: "qwen3-embedding:8b", dim: 4096 },
      search: undefined,
    },
    chunking: { target_tokens: 900, overlap: 0.15 },
    thresholds: {
      convergence: 0.85,
      magnitude_epsilon: 0.3,
      staleness_days: 47,
      dangling_days: 3,
      conflict_warn: 0.3,
      theta_mixed: 45,
      theta_critical: 70,
      fiedler_drop: 0.1,
      max_log_n: 9,
    },
    rrf: { k: 60 },
  };

  let setCalls: Array<{ key: string; value: unknown }> = [];
  const client = {
    getLoreMindConfig: () => ({ config: undefined, resolved: mockResolved }),
    setLoreMindConfig: (key: string, value: unknown) => {
      setCalls.push({ key, value });
    },
  } as unknown as WorkerClient;

  registerTools(server, client);
  const config = handlers.get("config");
  expect(config).toBeDefined();

  // No args → curated view
  const curatedRes = await config!({});
  const curatedText = curatedRes.content[0].text as string;
  expect(curatedText).toContain("Generation");
  expect(curatedText).toContain("qwen3:8b");
  expect(curatedText).toContain("Embedding");
  expect(curatedText).toContain("qwen3-embedding:8b");
  expect(curatedText).toContain("Thresholds");
  expect(curatedText).toContain("rrf.k");

  // Key only → get
  const getRes = await config!({ key: "ai.generation.model" });
  const getText = getRes.content[0].text as string;
  expect(getText).toContain("ai.generation.model");
  expect(getText).toContain("qwen3:8b");
  expect(getText).toContain("(default / global)");

  // Key + value → set
  const setRes = await config!({ key: "ai.generation.model", value: "kimi-k2.5" });
  const setText = setRes.content[0].text as string;
  expect(setText).toContain("Set ai.generation.model");
  expect(setText).toContain("kimi-k2.5");
  expect(setCalls).toEqual([{ key: "ai.generation.model", value: "kimi-k2.5" }]);
});
