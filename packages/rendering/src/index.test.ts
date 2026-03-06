import { expect, test } from "bun:test";
import type { LsResult, QueryResult, RecallResult, StatusResult } from "@lore/sdk";
import { renderAsk, renderAskBrief, renderLs, renderRecall, renderStatus } from "./index.ts";

function sampleStatus(): StatusResult {
  return {
    health: "degrading",
    summary: "81 concepts, debt 12.3%",
    debt: 12.3,
    priorities: [],
    active_narratives: [],
    dangling_narratives: [],
    maintenance: {
      status: "on-track",
      min_delta_rate: 1,
      current_rate: 1,
    },
    suggestions: [],
  };
}

function sampleLs(): LsResult {
  return {
    lore_mind: {
      name: "flowlake",
      code_path: "/tmp/flowlake",
      lore_path: "/tmp/.lore/flowlake",
      registered_at: "2026-03-03T00:00:00.000Z",
    },
    concepts: [],
    manifest: null,
    openNarratives: [],
    debt: 12.3,
    debt_trend: "caution",
  };
}

test("renderStatus uses route defaults", () => {
  const status = sampleStatus();

  const cli = renderStatus(status, { route: "cli" });
  expect(cli).toContain("Health:");
  expect(cli).toContain("debt 12.3%");

  const mcp = renderStatus(status, { route: "mcp" });
  expect(mcp).toContain("Health: degrading");
  expect(mcp).toContain("Debt path:");

  const http = renderStatus(status, { route: "http" });
  const parsed = JSON.parse(http) as StatusResult;
  expect(parsed.debt).toBe(12.3);
});

test("renderLs uses route defaults", () => {
  const ls = sampleLs();

  const cli = renderLs(ls, { route: "cli" });
  expect(cli).toContain("flowlake");
  expect(cli).toContain("debt 12.3%");

  const mcp = renderLs(ls, { route: "mcp" });
  expect(mcp).toContain("**flowlake**");

  const http = renderLs(ls, { route: "http" });
  const parsed = JSON.parse(http) as LsResult;
  expect(parsed.lore_mind.name).toBe("flowlake");
});

test("explicit format override beats route defaults", () => {
  const ls = sampleLs();
  const jsonFromCliRoute = renderLs(ls, { route: "cli", format: "json", prettyJson: false });
  expect(jsonFromCliRoute.startsWith("{\"")).toBe(true);
});

function sampleQueryResult(): QueryResult {
  return {
    result_id: "01ASK123",
    meta: {
      query: "how auth works",
      generated_at: "2026-02-24T00:00:00.000Z",
      generated_in: "12ms",
      brief: false,
      scanned: {
        local_candidates: 2,
        returned_results: 1,
        return_limit: 20,
        vector_limit: 20,
        text_vector_candidates: 2,
        code_vector_candidates: 2,
        bm25_source_candidates: 0,
        bm25_chunk_candidates: 2,
        doc_vector_candidates: 0,
        bm25_doc_candidates: 0,
        fused_candidates: 2,
        staleness_checks: 1,
        web_search_enabled: false,
        web_results: 0,
        journal_candidates: 1,
        journal_results: 1,
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
      narrative: "Direct answer.",
      kind: "generated",
      sources: [],
      citations: [],
      counts: { concepts: 1, files: 1, symbols: 0, journal_entries: 1 },
      claims: [
        {
          text: "Auth validates tokens before issuing sessions",
          source_concepts: ["auth-model"],
          confidence: 0.92,
          max_staleness: 0.1,
        },
      ],
      unbound_source_symbols: ["authenticateUser"],
    },
    next_actions: [
      {
        kind: "show",
        primary: true,
        concept: "auth-model",
        reason: "Inspect the canonical concept before making a change.",
      },
      {
        kind: "recall",
        primary: false,
        section: "sources",
        reason: "Expand the sources, file refs, and bindings behind this answer.",
      },
      {
        kind: "trail",
        primary: false,
        narrative: "auth-debug",
        reason: "Replay the strongest investigation trail behind this answer.",
      },
    ],
    results: [
      {
        concept: "auth-model",
        content: "auth content",
        summary: "auth summary",
        meta: {
          chunk_id: "chunk-1",
          files: ["src/auth.ts"],
          score: 0.92,
          residual: 0.1,
          staleness: 0.2,
          symbol_drift: "none",
          symbols_bound: 1,
          symbols_drifted: 0,
          last_updated: "2026-02-20T00:00:00.000Z",
          bindings: [
            {
              symbol: "authenticateUser",
              kind: "function",
              file: "src/auth.ts",
              line: 12,
              type: "ref",
              confidence: 0.91,
            },
          ],
        },
      },
    ],
    journal_results: [
      {
        narrative_name: "auth-debug",
        narrative_intent: "Investigate auth regression",
        narrative_status: "closed",
        total_entries: 3,
        matched_entries: [
          {
            content: "Found the issue in authenticateUser.",
            topics: ["auth"],
            status: "confirmed",
            created_at: "2026-02-25T12:00:00.000Z",
            score: 0.08,
            entry_index: 2,
          },
        ],
        other_topics: [],
        opened_at: "2026-02-25T10:00:00.000Z",
        closed_at: "2026-02-25T14:00:00.000Z",
      },
    ],
    web_results: [],
  };
}

test("renderAskBrief includes provenance, attribution, result_id, and CLI guidance", () => {
  const rendered = renderAskBrief(sampleQueryResult(), { route: "cli" });
  expect(rendered).toContain("Direct answer.");
  expect(rendered).toContain("Based on 1 concept, 1 source file.");
  expect(rendered).toContain("## Attribution");
  expect(rendered).toContain("## Next");
  expect(rendered).toContain("lore show auth-model --from-result 01ASK123");
  expect(rendered).toContain("lore recall 01ASK123 --section sources");
  expect(rendered).toContain("lore trail auth-debug --from-result 01ASK123");
  expect(rendered).toContain("[92%] Auth validates tokens before issuing sessions [auth-model]");
  expect(rendered).toContain("lore recall 01ASK123");
  expect(rendered).toContain("lore score 01ASK123 <1-5>");
  expect(rendered).toContain("lore trail auth-debug");
  expect(rendered).toContain("lore sys concept bind <concept> <symbol>");
});

test("renderAsk includes sources and MCP guidance", () => {
  const rendered = renderAsk(sampleQueryResult(), { route: "mcp", includeSources: true });
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("- auth-model (score 92.0%)");
  expect(rendered).toContain('show(concept="auth-model", result_id="01ASK123")');
  expect(rendered).toContain("bindings: authenticateUser (function, src/auth.ts:12)");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain('trail(narrative="auth-debug", result_id="01ASK123")');
});

test("renderRecall renders requested sections", () => {
  const recalled: RecallResult = {
    result_id: "01ASK123",
    query_text: "how auth works",
    result: sampleQueryResult(),
    score: 4,
    scored_by: "agent",
    created_at: "2026-02-27T10:00:00.000Z",
  };

  const rendered = renderRecall(recalled, "full");
  expect(rendered).toContain('Recalled: "how auth works"');
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("## Investigation Trail");
});
