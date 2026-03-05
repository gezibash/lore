import { expect, test } from "bun:test";
import type { ConceptRow, QueryResult, RegistryEntry } from "@lore/worker";
import { formatAskCli, formatLs } from "./formatters.ts";

const ANSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

function sampleQueryResult(): QueryResult {
  return {
    result_id: "01ASKCLI",
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
        web_search_enabled: true,
        web_results: 1,
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
      narrative: "Direct answer.\n- Auth uses token validation.\n- Cache is invalidated on logout.",
      kind: "generated" as const,
      sources: [],
      citations: [],
      counts: { concepts: 1, files: 1, symbols: 0, journal_entries: 1 },
      claims: [
        {
          text: "Auth validates tokens before issuing sessions",
          source_concepts: ["auth-model"],
          confidence: 0.9,
          max_staleness: 0.1,
        },
      ],
      unbound_source_symbols: ["authenticateUser"],
    },
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
          symbols_bound: 0,
          symbols_drifted: 0,
          last_updated: "2026-02-20T00:00:00.000Z",
        },
      },
    ],
    web_results: [
      {
        title: "Auth docs",
        url: "https://example.com/auth",
        snippet: "Auth overview",
        source: "exa",
      },
    ],
    journal_results: [
      {
        narrative_name: "auth-debug",
        narrative_intent: "Investigate auth regression",
        narrative_status: "closed",
        total_entries: 2,
        matched_entries: [
          {
            content: "Found the regression in authenticateUser.",
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
  };
}

test("formatAskCli returns summary only by default", () => {
  const rendered = stripAnsi(formatAskCli(sampleQueryResult()));
  expect(rendered).toContain("Direct answer.");
  expect(rendered).toContain("Based on 1 concept, 1 source file.");
  expect(rendered).toContain("## Attribution");
  expect(rendered).toContain("Result ID: 01ASKCLI");
  expect(rendered).toContain("lore recall 01ASKCLI");
  expect(rendered).toContain("lore score 01ASKCLI <1-5>");
  expect(rendered).toContain("lore trail auth-debug");
  expect(rendered).toContain("lore sys concept bind <concept> <symbol>");
  expect(rendered).toContain("## Investigation Trail");
  expect(rendered).not.toContain("## Sources");
});

test("formatAskCli includes sources when requested", () => {
  const rendered = stripAnsi(formatAskCli(sampleQueryResult(), { includeSources: true }));
  expect(rendered).toContain("Direct answer.");
  expect(rendered).toContain("## Sources");
  expect(rendered).toContain("- auth-model (score 92.0%)");
  expect(rendered).toContain("files: src/auth.ts");
  expect(rendered).toContain("## Web Sources");
  expect(rendered).toContain("https://example.com/auth");
  expect(rendered).toContain("Result ID: 01ASKCLI");
});

test("formatLs keeps staleness and cluster columns separated with ANSI colors", () => {
  const loreMind = {
    name: "swarm",
    code_path: "/tmp/swarm",
    lore_path: "/tmp/.lore/swarm",
    registered_at: "2026-02-23T00:00:00.000Z",
  } satisfies { name: string } & RegistryEntry;

  const concepts: ConceptRow[] = [
    {
      version_id: "v1",
      id: "c1",
      name: "service-layer-architecture",
      active_chunk_id: "chunk-1",
      residual: 0,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: 0,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
  ];

  const rendered = stripAnsi(formatLs(loreMind, concepts, [], { debt: 0, trend: "stable" }));
  expect(rendered).not.toContain("low0");
  expect(rendered).toMatch(/low\s+—\s+0/);
  expect(rendered).not.toMatch(/0\.00\s+·/);
  expect(rendered).not.toMatch(/low\s+·/);
  expect(rendered).not.toContain("→");
});

test("formatLs renders provided debt snapshot values", () => {
  const loreMind = {
    name: "swarm",
    code_path: "/tmp/swarm",
    lore_path: "/tmp/.lore/swarm",
    registered_at: "2026-02-23T00:00:00.000Z",
  } satisfies { name: string } & RegistryEntry;

  const rendered = stripAnsi(
    formatLs(loreMind, [], [], {
      debt: 79,
      trend: "stable, live ref drift",
    }),
  );

  expect(rendered).toContain("debt 79.0%");
});

test("formatLs sorts by residual then staleness and shows trend arrows", () => {
  const loreMind = {
    name: "swarm",
    code_path: "/tmp/swarm",
    lore_path: "/tmp/.lore/swarm",
    registered_at: "2026-02-23T00:00:00.000Z",
  } satisfies { name: string } & RegistryEntry;

  const concepts: ConceptRow[] = [
    {
      version_id: "v1",
      id: "c-low",
      name: "low-risk",
      active_chunk_id: "chunk-1",
      residual: 0.1,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: 1,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
    {
      version_id: "v1",
      id: "c-high",
      name: "high-risk",
      active_chunk_id: "chunk-2",
      residual: 0.9,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.2,
      cluster: 0,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
  ];

  const rendered = stripAnsi(
    formatLs(loreMind, concepts, [], {
      debt: 50,
      trend: "stable",
      debtDelta: 0.02,
      conceptTrends: [
        {
          concept_id: "c-low",
          residual_delta: -0.01,
          staleness_delta: -0.02,
        },
        {
          concept_id: "c-high",
          residual_delta: 0.05,
          staleness_delta: 0.01,
        },
      ],
    }),
  );

  const highIndex = rendered.indexOf("high-risk");
  const lowIndex = rendered.indexOf("low-risk");
  expect(highIndex).toBeGreaterThan(-1);
  expect(lowIndex).toBeGreaterThan(-1);
  expect(highIndex).toBeLessThan(lowIndex);
  expect(rendered).toContain("debt 50.0%");
  expect(rendered).toContain("45% ↑");
  expect(rendered).toContain("5% ↓");
  expect(rendered).not.toContain("0.90 ↑");
  expect(rendered).not.toContain("0.10 ↓");
});

test("formatLs can group concepts by cluster", () => {
  const loreMind = {
    name: "swarm",
    code_path: "/tmp/swarm",
    lore_path: "/tmp/.lore/swarm",
    registered_at: "2026-02-23T00:00:00.000Z",
  } satisfies { name: string } & RegistryEntry;

  const concepts: ConceptRow[] = [
    {
      version_id: "v1",
      id: "c-a",
      name: "cluster-two-item",
      active_chunk_id: "chunk-a",
      residual: 0.6,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: 2,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
    {
      version_id: "v1",
      id: "c-b",
      name: "cluster-one-high",
      active_chunk_id: "chunk-b",
      residual: 0.8,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: 1,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
    {
      version_id: "v1",
      id: "c-c",
      name: "cluster-one-low",
      active_chunk_id: "chunk-c",
      residual: 0.2,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: 1,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
    {
      version_id: "v1",
      id: "c-d",
      name: "unclustered",
      active_chunk_id: "chunk-d",
      residual: 0.9,
      churn: null,
      ground_residual: null,
      lore_residual: null,
      staleness: 0.1,
      cluster: null,
      is_hub: 0,
      lifecycle_status: "active",
      archived_at: null,
      lifecycle_reason: null,
      merged_into_concept_id: null,
      inserted_at: "2026-02-23T00:00:00.000Z",
    },
  ];

  const rendered = stripAnsi(
    formatLs(loreMind, concepts, [], {
      debt: 40,
      trend: "stable",
      groupBy: "cluster",
    }),
  );

  const cluster1Index = rendered.indexOf("CLUSTER 1 (2)");
  const cluster2Index = rendered.indexOf("CLUSTER 2 (1)");
  const unclusteredIndex = rendered.indexOf("UNCLUSTERED (1)");
  expect(cluster1Index).toBeGreaterThan(-1);
  expect(cluster2Index).toBeGreaterThan(-1);
  expect(unclusteredIndex).toBeGreaterThan(-1);
  expect(cluster1Index).toBeLessThan(cluster2Index);
  expect(cluster2Index).toBeLessThan(unclusteredIndex);

  const clusterOneBlock = rendered.slice(cluster1Index, cluster2Index);
  const highIndex = clusterOneBlock.indexOf("cluster-one-high");
  const lowIndex = clusterOneBlock.indexOf("cluster-one-low");
  expect(highIndex).toBeGreaterThan(-1);
  expect(lowIndex).toBeGreaterThan(-1);
  expect(highIndex).toBeLessThan(lowIndex);
});
