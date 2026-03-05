import { expect, test } from "bun:test";
import { createWorkerClient, type WorkerClientOptions } from "./index.ts";

type MockWorkerClient = WorkerClientOptions["client"];

test("createWorkerClient delegates to provided client", async () => {
  let called = false;
  const result = {
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
  };

  const client = createWorkerClient({
    client: {
      query: async () => {
        called = true;
        return result;
      },
      shutdown: () => {},
    } as unknown as MockWorkerClient,
  });

  const queried = await client.query("q");
  expect(called).toBeTrue();
  expect(queried.meta.query).toBe("q");
});
