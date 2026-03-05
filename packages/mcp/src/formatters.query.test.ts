import { expect, test } from "bun:test";
import type { QueryResult, NarrativeTrailResult, RecallResult } from "@lore/worker";
import { formatAskMcp, formatAskMcpBrief, formatRecallMcp, formatNarrativeTrail, formatQuery } from "./formatters.ts";

function sampleQueryResult(): QueryResult {
  return {
    meta: {
      query: "what is hyperswarm",
      generated_at: "2026-02-23T00:00:00.000Z",
      generated_in: "2.5s",
      brief: false,
      scanned: {
        local_candidates: 5,
        returned_results: 2,
        return_limit: 20,
        vector_limit: 20,
        text_vector_candidates: 8,
        code_vector_candidates: 7,
        bm25_source_candidates: 0,
        bm25_chunk_candidates: 4,
        doc_vector_candidates: 0,
        bm25_doc_candidates: 0,
        fused_candidates: 9,
        staleness_checks: 2,
        web_search_enabled: true,
        web_results: 1,
        journal_candidates: 0,
        journal_results: 0,
      },
      rerank: {
        enabled: true,
        attempted: true,
        applied: false,
        model: "rerank-v3.5",
        candidates: 5,
        reason: "no order change",
      },
      executive_summary: {
        enabled: true,
        attempted: true,
        generated: true,
        model: "qwen3:8b",
        model_id: "",
        reason: "ok",
        source_matches: 5,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: true,
        hits_total: 3,
        call_site_hits: 0,
        files_considered: 2,
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
      narrative: "Hyperswarm is a DHT rendezvous layer used here to find peers.",
      kind: "generated" as const,
      sources: [],
      citations: [],
      counts: { concepts: 5, files: 2, symbols: 0, journal_entries: 0 },
    },
    results: [
      {
        concept: "dm-p2p-flow",
        content: "content",
        summary: "summary",
        meta: {
          chunk_id: "01TESTCHUNK",
          files: ["src/net/swarm.ts", "src/mcp/server.ts"],
          score: 0.12345,
          residual: 0.07,
          staleness: 0.31,
          symbol_drift: "drifted",
          symbols_bound: 3,
          symbols_drifted: 1,
          last_updated: "2026-02-20T00:00:00.000Z",
        },
      },
    ],
    web_results: [
      {
        title: "x",
        url: "https://example.com",
        snippet: "y",
        source: "exa",
      },
    ],
  };
}

test("formatAskMcp returns summary only by default", () => {
  const rendered = formatAskMcp(sampleQueryResult());
  expect(rendered).toContain("Hyperswarm is a DHT rendezvous layer");
  expect(rendered).not.toContain("## Sources");
  expect(rendered).not.toContain("dm-p2p-flow");
});

test("formatAskMcp includes sources when requested", () => {
  const rendered = formatAskMcp(sampleQueryResult(), { includeSources: true });
  expect(rendered).toContain("Hyperswarm is a DHT rendezvous layer");
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("- dm-p2p-flow (score 12.3%)");
  expect(rendered).toContain("files: src/net/swarm.ts, src/mcp/server.ts");
  expect(rendered).toContain("## Web Sources");
  expect(rendered).toContain("https://example.com");
});

test("formatQuery renders structured query metadata and result diagnostics", () => {
  const result = sampleQueryResult();

  const rendered = formatQuery(result);
  expect(rendered).toContain("## Query Metadata");
  expect(rendered).toContain('query: "what is hyperswarm"');
  expect(rendered).toContain("generated_in: 2.5s");
  expect(rendered).toContain("scanned:");
  expect(rendered).toContain("  local_candidates: 5");
  expect(rendered).toContain("  return_limit: 20");
  expect(rendered).toContain("  text_vector_candidates: 8");
  expect(rendered).toContain("  code_vector_candidates: 7");
  expect(rendered).toContain("  fused_candidates: 9");
  expect(rendered).toContain("  staleness_checks: 2");
  expect(rendered).toContain("  web:");
  expect(rendered).toContain("    enabled: true");
  expect(rendered).toContain("rerank:");
  expect(rendered).toContain("  attempted: true");
  expect(rendered).toContain('  reason: "no order change"');
  expect(rendered).toContain("executive_summary:");
  expect(rendered).toContain("  generated: true");
  expect(rendered).toContain("grounding:");
  expect(rendered).toContain("  exactness_detected: true");
  expect(rendered).toContain("## Executive Summary");
  expect(rendered).toContain("Hyperswarm is a DHT rendezvous layer");
  expect(rendered).toContain("## Result 1: dm-p2p-flow");
  expect(rendered).toContain("- chunk_id: 01TESTCHUNK");
  expect(rendered).toContain("- symbol_drift: drifted");
  expect(rendered).toContain("- files: src/net/swarm.ts, src/mcp/server.ts");
  expect(rendered).toContain("content");
});

function sampleJournalResults(): QueryResult["journal_results"] {
  return [
    {
      narrative_name: "auth-perf-debug",
      narrative_intent: "Investigate auth performance regression",
      narrative_status: "closed",
      total_entries: 8,
      matched_entries: [
        {
          content:
            "The auth bottleneck is in the token validation middleware — it calls the DB on every request.",
          topics: ["auth", "performance"],
          status: "confirmed",
          created_at: "2026-02-25T12:00:00.000Z",
          score: 0.0812,
          entry_index: 3,
        },
        {
          content: "Tried caching tokens in memory but session invalidation breaks.",
          topics: ["auth", "caching"],
          status: "dead-end",
          created_at: "2026-02-25T13:00:00.000Z",
          score: 0.0543,
          entry_index: 5,
        },
      ],
      other_topics: ["session-management", "jwt"],
      opened_at: "2026-02-25T10:00:00.000Z",
      closed_at: "2026-02-25T15:00:00.000Z",
    },
  ];
}

test("formatAskMcp shows grouped investigation trail without sources", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const rendered = formatAskMcp(result);
  expect(rendered).toContain("Hyperswarm is a DHT rendezvous layer");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain("**auth-perf-debug**");
  expect(rendered).toContain("Investigate auth performance regression");
  expect(rendered).toContain("[confirmed]");
  expect(rendered).toContain("[dead-end]");
  expect(rendered).toContain("8 entries (2 matched)");
  expect(rendered).toContain("Also covers: session-management, jwt");
  expect(rendered).not.toContain("## Sources");
});

test("formatAskMcp shows grouped investigation trail with sources", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const rendered = formatAskMcp(result, { includeSources: true });
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain("**auth-perf-debug**");
  expect(rendered).toContain("token validation middleware");
  expect(rendered).toContain("8 entries (2 matched)");
});

test("formatAskMcp omits investigation trail when no journal results", () => {
  const result = sampleQueryResult();
  const rendered = formatAskMcp(result);
  expect(rendered).not.toContain("## Investigation Trail");
});

test("formatAskMcp omits Also covers when no other topics", () => {
  const result = sampleQueryResult();
  result.journal_results = [
    {
      ...sampleJournalResults()![0]!,
      other_topics: [],
    },
  ];
  const rendered = formatAskMcp(result);
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).not.toContain("Also covers:");
});

test("formatQuery includes journal scan stats in YAML", () => {
  const result = sampleQueryResult();
  result.meta.scanned.journal_candidates = 12;
  result.meta.scanned.journal_results = 3;
  const rendered = formatQuery(result);
  expect(rendered).toContain("  journal:");
  expect(rendered).toContain("    candidates: 12");
  expect(rendered).toContain("    results: 3");
});

test("formatQuery shows grouped investigation trail section", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const rendered = formatQuery(result);
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain("### auth-perf-debug");
  expect(rendered).toContain("Investigate auth performance regression");
  expect(rendered).toContain("closed");
  expect(rendered).toContain("8 entries (2 matched)");
  expect(rendered).toContain("[confirmed]");
  expect(rendered).toContain("(3/8)");
  expect(rendered).toContain("(5/8)");
  expect(rendered).toContain("Topics: auth, performance");
  expect(rendered).toContain("Also covers: session-management, jwt");
});

test("formatAskMcp shows entry position in investigation trail", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const rendered = formatAskMcp(result);
  expect(rendered).toContain("(3/8)");
  expect(rendered).toContain("(5/8)");
});

test("formatAskMcpBrief returns summary with provenance and result_id", () => {
  const result = sampleQueryResult();
  result.result_id = "01ABC123";
  const rendered = formatAskMcpBrief(result);
  expect(rendered).toContain("Hyperswarm is a DHT rendezvous layer");
  expect(rendered).toContain("Based on 5 concepts");
  expect(rendered).toContain("Result ID: 01ABC123");
  expect(rendered).toContain("· 2.5s");
  expect(rendered).toContain("recall(result_id)");
  expect(rendered).toContain("score(result_id, 1-5)");
  expect(rendered).not.toContain("## Sources");
  expect(rendered).not.toContain("dm-p2p-flow");
});

test("formatAskMcpBrief includes claims when present", () => {
  const result = sampleQueryResult();
  result.result_id = "01ABC123";
  result.executive_summary!.claims = [
    { text: "Auth uses JWT", source_concepts: ["auth-model"], confidence: 0.9 },
  ];
  const rendered = formatAskMcpBrief(result);
  expect(rendered).toContain("## Attribution");
  expect(rendered).toContain("[90%] Auth uses JWT [auth-model]");
});

test("formatAskMcpBrief omits result_id footer when not present", () => {
  const result = sampleQueryResult();
  const rendered = formatAskMcpBrief(result);
  expect(rendered).not.toContain("Result ID:");
});

test("formatRecallMcp renders full recalled result", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  result.symbol_results = [
    {
      symbol_id: "sym-1",
      name: "authenticateUser",
      qualified_name: "authenticateUser",
      kind: "function",
      signature: null,
      file_path: "src/auth.ts",
      line_start: 42,
      line_end: 80,
      bound_concepts: ["auth-model"],
    },
  ];
  const recalled: RecallResult = {
    result_id: "01RECALL",
    query_text: "how does auth work",
    result,
    score: 4,
    scored_by: "agent",
    created_at: "2026-02-27T10:00:00.000Z",
  };
  const rendered = formatRecallMcp(recalled);
  expect(rendered).toContain('Recalled: "how does auth work"');
  expect(rendered).toContain("scored: 4/5");
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("dm-p2p-flow");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain("## Symbols");
  expect(rendered).toContain("authenticateUser");
});

test("formatRecallMcp renders sources section only", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const recalled: RecallResult = {
    result_id: "01RECALL",
    query_text: "how does auth work",
    result,
    score: null,
    scored_by: null,
    created_at: "2026-02-27T10:00:00.000Z",
  };
  const rendered = formatRecallMcp(recalled, "sources");
  expect(rendered).toContain("unscored");
  expect(rendered).toContain("## Sources");
  expect(rendered).not.toContain("## Investigation Trail");
});

test("formatRecallMcp renders journal section only", () => {
  const result = sampleQueryResult();
  result.journal_results = sampleJournalResults();
  const recalled: RecallResult = {
    result_id: "01RECALL",
    query_text: "query",
    result,
    score: null,
    scored_by: null,
    created_at: "2026-02-27T10:00:00.000Z",
  };
  const rendered = formatRecallMcp(recalled, "journal");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).not.toContain("## Sources");
});

test("formatNarrativeTrail renders full trail with all entries", () => {
  const thread: NarrativeTrailResult = {
    narrative: {
      name: "auth-perf-debug",
      intent: "Investigate auth performance regression",
      status: "closed",
      entry_count: 3,
      opened_at: "2026-02-25T10:00:00.000Z",
      closed_at: "2026-02-25T15:00:00.000Z",
    },
    entries: [
      {
        content: "Starting investigation into auth performance.",
        topics: ["auth", "performance"],
        status: "finding",
        created_at: "2026-02-25T11:00:00.000Z",
        position: 1,
      },
      {
        content: "The bottleneck is token validation hitting the DB on every request.",
        topics: ["auth", "performance"],
        status: "confirmed",
        created_at: "2026-02-25T12:00:00.000Z",
        position: 2,
      },
      {
        content: "Caching tokens in memory breaks session invalidation.",
        topics: ["auth", "caching"],
        status: "dead-end",
        created_at: "2026-02-25T13:00:00.000Z",
        position: 3,
      },
    ],
    topics_covered: ["auth", "performance", "caching"],
  };
  const rendered = formatNarrativeTrail(thread);
  expect(rendered).toContain("## auth-perf-debug");
  expect(rendered).toContain("Investigate auth performance regression");
  expect(rendered).toContain("closed · 3 entries");
  expect(rendered).toContain("### Entry 1");
  expect(rendered).toContain("### Entry 2");
  expect(rendered).toContain("### Entry 3");
  expect(rendered).toContain("[finding]");
  expect(rendered).toContain("[confirmed]");
  expect(rendered).toContain("[dead-end]");
  expect(rendered).toContain("Starting investigation");
  expect(rendered).toContain("bottleneck is token validation");
  expect(rendered).toContain("Caching tokens");
  expect(rendered).toContain("Topics: auth, performance, caching");
});
