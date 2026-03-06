import { expect, test } from "bun:test";
import { createLoreClient, type LoreClientOptions } from "./index.ts";

type MockEngine = LoreClientOptions["engine"];

test("createLoreClient is exported", () => {
  expect(typeof createLoreClient).toBe("function");
});

test("queryForOrchestration delegates to engine", async () => {
  const client = createLoreClient({
    engine: {
      queryForOrchestration: async () => ({
        meta: {
          query: "q",
          generated_at: "2026-02-24T00:00:00.000Z",
          generated_in: "1ms",
          brief: false,
          scanned: {
            local_candidates: 0,
            returned_results: 0,
            return_limit: 20,
            vector_limit: 20,
            text_vector_candidates: 0,
            code_vector_candidates: 0,
            bm25_source_candidates: 0,
            bm25_chunk_candidates: 0,
            fused_candidates: 0,
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
            candidates: 0,
            reason: "disabled",
          },
          executive_summary: {
            enabled: false,
            attempted: false,
            generated: false,
            model: "qwen3:8b",
            model_id: "",
            reason: "disabled",
            source_matches: 0,
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          },
          grounding: {
            enabled: true,
            attempted: false,
            exactness_detected: false,
            hits_total: 0,
            call_site_hits: 0,
            files_considered: 0,
            mode: "always-on",
            reason: "no-code-path",
          },
          structural_boost: {
            enabled: false,
            symbols_matched: 0,
            concepts_boosted: 0,
            boost_map: {},
          },
        },
        results: [],
      }),
      shutdown: () => {},
    } as unknown as MockEngine,
  });

  const result = await client.queryForOrchestration("q");
  expect(result.meta.query).toBe("q");
});

test("searchWeb delegates to engine", async () => {
  const client = createLoreClient({
    engine: {
      searchWeb: async () =>
        [
          {
            title: "x",
            url: "https://example.com",
            snippet: "y",
            source: "exa",
          },
        ] as const,
      shutdown: () => {},
    } as unknown as MockEngine,
  });

  const results = await client.searchWeb("q");
  expect(results.length).toBe(1);
  expect(results[0]?.title).toBe("x");
});

test("summarizeMatches delegates to engine", async () => {
  const client = createLoreClient({
    engine: {
      summarizeMatches: async () => ({
        narrative: "summary",
        kind: "generated" as const,
        sources: [],
        citations: [],
        counts: { concepts: 0, files: 0, symbols: 0, journal_entries: 0 },
      }),
      shutdown: () => {},
    } as unknown as MockEngine,
  });

  const summary = await client.summarizeMatches("q", []);
  expect(summary?.narrative).toBe("summary");
});
