import { expect, test } from "bun:test";
import type { LsResult, QueryResult, RecallResult, StatusResult } from "@lore/sdk";
import { renderAsk, renderAskBrief, renderLs, renderRecall, renderStatus } from "./index.ts";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function sampleStatus(): StatusResult {
  return {
    lore_name: "flowlake",
    health: "degrading",
    summary: "81 concepts, debt 12%",
    debt_band: "caution",
    debt: 0.12,
    priorities: [
      {
        concept: "performance-parallelization",
        action: "review",
        reason: "High pressure: 52% (ground=27%, lore=62%)",
      },
    ],
    active_narratives: [],
    dangling_narratives: [],
    maintenance: {
      status: "on-track",
      min_delta_rate: 1,
      current_rate: 1,
    },
    lake: {
      source_chunks: 10,
      source_files: 3,
      doc_chunks: 2,
      doc_files: 1,
      journal_entries: 5,
      last_code_indexed_at: "2026-03-06T00:00:00.000Z",
      last_doc_indexed_at: "2026-03-06T00:00:00.000Z",
      discovered_source_files: 3,
      stale_source_files: 0,
      discovered_doc_files: 1,
      stale_doc_files: 0,
    },
    suggestions: [],
  };
}

function indexLabel(status: StatusResult): string {
  // The FOCUS table renders first and can hold a concept named like a state
  // row, so the label is read from under the STATE header.
  const lines = stripAnsi(renderStatus(status, { route: "cli" })).split("\n");
  const header = lines.findIndex((row) => row.trim().startsWith("STATE"));
  if (header < 0) return "";
  const row = lines.slice(header + 1).find((line) => /^\s*index\s{2,}/.test(line));
  return row ? row.trim().replace(/^index\s+/, "") : "";
}

test("the index label grades the pair by its worst lane", () => {
  const clean = sampleStatus();
  expect(indexLabel(clean)).toBe("fresh");

  // One lane drifts a little, the other lane is clean: drift, not stale. The
  // count says how far behind, because `drift` alone reads the same whether
  // one file moved or four hundred did.
  const codeDrift = sampleStatus();
  codeDrift.lake = { ...clean.lake!, discovered_source_files: 1022, stale_source_files: 3 };
  expect(indexLabel(codeDrift)).toBe("drift (3)");

  const docDrift = sampleStatus();
  docDrift.lake = { ...clean.lake!, discovered_doc_files: 179, stale_doc_files: 3 };
  expect(indexLabel(docDrift)).toBe("drift (3)");

  // A lane above the drift ceiling still reads stale.
  const codeStale = sampleStatus();
  codeStale.lake = { ...clean.lake!, discovered_source_files: 1022, stale_source_files: 300 };
  expect(indexLabel(codeStale)).toBe("stale (300)");

  // Both lanes count: the row is about files the index has not read.
  const bothStale = sampleStatus();
  bothStale.lake = {
    ...clean.lake!,
    discovered_source_files: 1022,
    stale_source_files: 300,
    discovered_doc_files: 179,
    stale_doc_files: 7,
  };
  expect(indexLabel(bothStale)).toBe("stale (307)");
});

test("a stale index is the next command, ahead of a concept priority", () => {
  const status = sampleStatus();
  status.dangling_narratives = [];
  status.active_narratives = [];
  status.priorities = [{ concept: "auth-model", action: "review", reason: "High pressure" }];
  status.lake = {
    ...status.lake!,
    discovered_source_files: 1022,
    stale_source_files: 300,
  };

  // Every priority was computed from the index, so advice drawn from an index
  // that has not read 300 files describes code that already changed.
  const plain = stripAnsi(renderStatus(status, { route: "cli" }));
  expect(plain).toContain("lore ingest");
  expect(plain).not.toContain("lore show auth-model");
});

test("drift is too small to displace a concept priority", () => {
  const status = sampleStatus();
  status.dangling_narratives = [];
  status.active_narratives = [];
  status.priorities = [{ concept: "auth-model", action: "review", reason: "High pressure" }];
  status.lake = { ...status.lake!, discovered_source_files: 1022, stale_source_files: 3 };

  const plain = stripAnsi(renderStatus(status, { route: "cli" }));
  expect(plain).toContain("lore show auth-model");
});

test("a FOCUS row named like a state row does not shadow the index label", () => {
  const status = sampleStatus();
  status.priorities = [{ concept: "index-pipeline", action: "review", reason: "High pressure" }];
  expect(indexLabel(status)).toBe("fresh");
});

test("the doc lane measures stale doc files against doc files, not chunks", () => {
  const status = sampleStatus();
  // 4 stale of 20 doc files is 20%: high, so the pair reads stale. Against the
  // 578 chunks those files hold, the same 4 read 0.7% and the pair reads drift.
  status.lake = {
    ...status.lake!,
    discovered_source_files: 1022,
    stale_source_files: 3,
    doc_chunks: 578,
    doc_files: 20,
    discovered_doc_files: 20,
    stale_doc_files: 4,
  };
  expect(indexLabel(status)).toBe("stale (7)");

  const details = stripAnsi(renderStatus(status, { route: "cli", details: true }));
  expect(details).toContain("578 chunks · 20 files");
  expect(details).toContain("4 stale (20%)");
});

test("the lake block reports chunks and files as separate figures", () => {
  const status = sampleStatus();
  status.lake = { ...status.lake!, doc_chunks: 578, doc_files: 179, discovered_doc_files: 179 };

  const markdown = renderStatus(status, { format: "markdown" });
  expect(markdown).toContain("docs:    578 chunks · 179 files");
  expect(markdown).toContain("✓ fresh");

  const details = stripAnsi(renderStatus(status, { route: "cli", details: true }));
  expect(details).toContain("578 chunks · 179 files");
});

test("the markdown lake block grades both lanes and names the fix", () => {
  const drift = sampleStatus();
  drift.lake = { ...drift.lake!, discovered_source_files: 1022, stale_source_files: 3 };
  expect(renderStatus(drift, { format: "markdown" })).toContain("Minor index drift");

  const stale = sampleStatus();
  stale.lake = { ...stale.lake!, discovered_doc_files: 20, stale_doc_files: 4 };
  const markdown = renderStatus(stale, { format: "markdown" });
  expect(markdown).toContain("Index is stale");
  expect(markdown).toContain("4 stale (20%)");
});

test("a stale count under one percent reads <1%, never 0%", () => {
  const status = sampleStatus();
  status.lake = { ...status.lake!, discovered_source_files: 1022, stale_source_files: 3 };
  const details = stripAnsi(renderStatus(status, { route: "cli", details: true }));
  expect(details).toContain("3 stale (<1%)");
  expect(details).not.toContain("(0%)");
});

test("a stale count above the file count still reads at most 100%", () => {
  const status = sampleStatus();
  // A lake from an older producer can disagree with itself. The label must not
  // print a ratio a reader cannot act on.
  status.lake = { ...status.lake!, discovered_doc_files: 20, stale_doc_files: 25 };
  const details = stripAnsi(renderStatus(status, { route: "cli", details: true }));
  expect(details).toContain("25 stale (100%)");
  expect(details).not.toContain("125%");
});

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
    debt: 0.12,
    debt_trend: "caution",
  };
}

test("renderStatus uses route defaults", () => {
  const status = sampleStatus();

  const cli = renderStatus(status, { route: "cli" });
  const plainCli = stripAnsi(cli);
  expect(plainCli).toContain("flowlake");
  expect(plainCli).toContain("status");
  expect(plainCli).toContain("caution");
  expect(plainCli).toContain("FOCUS");
  expect(plainCli).toContain("STATE");
  expect(plainCli).toContain("NEXT");
  expect(cli).not.toContain("Health:");

  const cliDetails = renderStatus(status, { route: "cli", details: true });
  expect(cliDetails).toContain("Health:");
  expect(cliDetails).toContain("debt 12%");

  const http = renderStatus(status, { route: "http" });
  const parsed = JSON.parse(http) as StatusResult;
  expect(parsed.debt).toBe(0.12);
});

test("renderStatus names the symbol lane apart from the chunk lane", () => {
  const status = sampleStatus();
  status.priorities = [
    {
      concept: "(symbol embeddings)",
      action: "refresh embeddings",
      reason:
        "7 of 9 embedded symbols hold no vector on code model code-new (they hold code-old). Symbol search and automatic binding skip them. Run lore sys embeddings refresh.",
    },
  ];
  status.embedding_status = { total: 40, current_model: 40, stale: 0, model: "text-new" };
  status.symbol_embedding_status = {
    symbols: 12,
    total: 9,
    current_model: 2,
    stale: 7,
    model: "code-new",
  };

  const cli = stripAnsi(renderStatus(status, { route: "cli" }));
  expect(cli).toContain("symbol embeddings");
  expect(cli).toContain("refresh");
  expect(cli).toContain("7 stale");
  expect(cli).toContain("lore sys embeddings refresh");

  // The chunk lane is current, so the mismatch section names the symbol lane
  // alone. One combined figure would name neither.
  const markdown = renderStatus(status, { format: "markdown" });
  expect(markdown).toContain("7/9 embedded symbols hold no vector on code model **code-new**");
  expect(markdown).not.toContain("chunk embeddings use an outdated model");
});

test("renderStatus reports both lanes when both are stale", () => {
  const status = sampleStatus();
  status.embedding_status = { total: 40, current_model: 10, stale: 30, model: "text-new" };
  status.symbol_embedding_status = {
    symbols: 12,
    total: 9,
    current_model: 0,
    stale: 9,
    model: null,
  };

  const markdown = renderStatus(status, { format: "markdown" });
  expect(markdown).toContain("30/40 chunk embeddings use an outdated model");
  // No code model: the vectors are unreadable, and the repair starts at config.
  expect(markdown).toContain("9/9 embedded symbols hold vectors no reader can use");
  expect(markdown).toContain("ai.embedding.code.model");
  expect(markdown).toContain("lore sys embeddings refresh");
});

test("renderStatus names an emptied symbol lane", () => {
  const status = sampleStatus();
  status.symbol_embedding_status = {
    symbols: 12,
    total: 0,
    current_model: 0,
    stale: 0,
    model: "code-new",
  };

  const markdown = renderStatus(status, { format: "markdown" });
  expect(markdown).toContain("0/12 symbols hold a code vector");
});

test("renderStatus sends the database priority to the prune", () => {
  const status = sampleStatus();
  status.priorities = [
    {
      concept: "(database)",
      action: "prune database",
      reason: "412 row(s) belong to chunks or symbols that are gone. Run lore sys prune.",
    },
  ];

  const cli = stripAnsi(renderStatus(status, { route: "cli" }));
  expect(cli).toContain("database");
  expect(cli).toContain("412 orphaned");
  expect(cli).toContain("lore sys prune");
  // `lore show` takes a concept name, so a bracketed priority must never reach it.
  expect(cli).not.toContain("lore show (");
});

test("renderLs uses route defaults", () => {
  const ls = sampleLs();

  const cli = renderLs(ls, { route: "cli" });
  expect(cli).toContain("flowlake");
  expect(cli).toContain("debt 12%");

  const http = renderLs(ls, { route: "http" });
  const parsed = JSON.parse(http) as LsResult;
  expect(parsed.lore_mind.name).toBe("flowlake");
});

test("explicit format override beats route defaults", () => {
  const ls = sampleLs();
  const jsonFromCliRoute = renderLs(ls, { route: "cli", format: "json", prettyJson: false });
  expect(jsonFromCliRoute.startsWith('{"')).toBe(true);
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

test("renderAsk includes sources and CLI guidance", () => {
  const rendered = renderAsk(sampleQueryResult(), { route: "cli", includeSources: true });
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("- auth-model (score 92.0%)");
  expect(rendered).toContain("lore show auth-model --from-result 01ASK123");
  expect(rendered).toContain("bindings: authenticateUser (function, src/auth.ts:12)");
  // The nudge must state its own cost: binding raises residual until the prose
  // covers the symbol, so the operator does not read the rise as a mistake.
  expect(rendered).toContain("lore sys concept bind <concept> <symbol>");
  expect(rendered).toContain("raises the concept's residual until the prose covers the symbol");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).toContain("lore trail auth-debug --from-result 01ASK123");
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

/**
 * A summary that failed must say so. The retrieval survives it, and silence
 * would read as "this is the whole answer".
 */
test("a failed executive summary is reported and the sources are shown", () => {
  const result = sampleQueryResult();
  delete result.executive_summary;
  result.meta.executive_summary = {
    ...result.meta.executive_summary,
    attempted: true,
    generated: false,
    reason: "failed: The operation timed out.",
  };

  const rendered = renderAsk(result, { route: "cli" });

  expect(rendered).toContain("The executive summary failed: The operation timed out.");
  expect(rendered).toContain("ai.search.timeouts.executive_summary_ms");
  // Sources are printed even though the caller did not ask for them.
  expect(rendered).toContain("## Sources");
});
