import { expect, test } from "bun:test";
import {
  DEFAULT_EXECUTIVE_SUMMARY_SYSTEM_PROMPT,
  generateExecutiveSummary,
} from "./narrative-lifecycle.ts";
import type { ReasoningLevel, GenerationReasoningScope } from "@/types/index.ts";

type GenerateOpts = { timeoutMs?: number; reasoning?: ReasoningLevel; scope?: GenerationReasoningScope };
type GenerateFn = (system: string, user: string, opts?: GenerateOpts) => Promise<string>;

function mockGenerator(genFn: GenerateFn) {
  return {
    generate: genFn,
    async generateWithMeta(system: string, user: string, opts?: GenerateOpts) {
      const text = await genFn(system, user, opts);
      return { text, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, modelId: "mock" };
    },
  };
}

test("generateExecutiveSummary builds grounded evidence framing with expansion hints", async () => {
  let capturedSystem = "";
  let capturedUser = "";
  let capturedScope = "";

  const generator = mockGenerator(async (system: string, user: string, opts?: { scope?: string }) => {
    capturedSystem = system;
    capturedUser = user;
    capturedScope = opts?.scope ?? "";
    return "Direct answer.\n- Point one.\n- Point two.";
  });

  const summary = await generateExecutiveSummary(
    generator,
    "How does auth cache invalidation work?",
    [
      {
        lore_mind: "alpha",
        concept: "auth-model",
        score: 0.92,
        content:
          "Auth sessions are cached. Cache entries are invalidated during token rotation and logout.",
      },
      {
        lore_mind: "beta",
        concept: "cache-layer",
        score: 0.81,
        content:
          "The cache layer supports tag-based invalidation and refresh flow hooks for auth token updates.",
      },
    ],
    5,
    undefined,
  );

  expect(summary.kind).toBe("generated");
  expect(summary.narrative).toContain("Direct answer.");
  expect(summary.counts.concepts).toBe(2);
  expect(summary.counts.files).toBe(0);
  expect(capturedScope).toBe("executive_summary");
  expect(capturedSystem).toBe(DEFAULT_EXECUTIVE_SUMMARY_SYSTEM_PROMPT);
  expect(capturedUser).toContain("Task framing:");
  expect(capturedUser).toContain("Evidence scope:");
  expect(capturedUser).toContain("- Lore minds represented: 2");
  expect(capturedUser).toContain("Minor query expansion hints");
  expect(capturedUser).toContain("Grounding instructions:");
  expect(capturedUser).toContain("Grounding evidence (file:line + snippet):");
  expect(capturedUser).toContain("Evidence 1:");
  expect(capturedUser).toContain("Source Content:");
  expect(capturedUser).toMatch(/- [a-z0-9]+/);
});

test("generateExecutiveSummary returns uncertain for exactness queries without grounding hits", async () => {
  const generator = mockGenerator(async () => "This should be ignored.");

  const summary = await generateExecutiveSummary(
    generator,
    "Give exact file path and function for ask formatter",
    [
      {
        lore_mind: "local",
        concept: "cli-ux",
        score: 0.7,
        content: "Some concept content.",
      },
    ],
    1,
    undefined,
    undefined,
    {
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: true,
        hits_total: 0,
        files_considered: 0,
        mode: "always-on",
        reason: "no-hits",
        hits: [],
      },
    },
  );

  expect(summary.kind).toBe("uncertain");
  expect(summary.uncertainty_reason).toContain("exact path/function claims");
  expect(summary.citations).toEqual([]);
});

test("generateExecutiveSummary returns citations for exactness queries with hits", async () => {
  const generator = mockGenerator(async () => "Default local ask uses formatAskCli.\n- MCP ask uses formatAskMcp.");

  const summary = await generateExecutiveSummary(
    generator,
    "Give exact file path and function names",
    [
      {
        lore_mind: "local",
        concept: "cli-ux",
        score: 0.8,
        content: "formatter path details",
      },
    ],
    1,
    undefined,
    undefined,
    {
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: true,
        hits_total: 2,
        files_considered: 2,
        mode: "always-on",
        reason: "ok",
        hits: [
          {
            file: "packages/cli/src/formatters.ts",
            line: 84,
            snippet: "export function formatAskCli(",
            term: "formatAskCli",
          },
          {
            file: "packages/mcp/src/formatters.ts",
            line: 15,
            snippet: "export function formatAskMcp(",
            term: "formatAskMcp",
          },
        ],
      },
    },
  );

  expect(summary.kind).toBe("generated");
  expect(summary.citations).toHaveLength(2);
  expect(summary.citations[0]?.file).toBe("packages/cli/src/formatters.ts");
  expect(summary.citations[0]?.line).toBe(84);
  expect(summary.citations[1]?.file).toBe("packages/mcp/src/formatters.ts");
  expect(summary.citations[1]?.line).toBe(15);
  // Narrative should not have citations baked in (exactness query keeps LLM citations)
  expect(summary.narrative).toContain("formatAskCli");
});

test("generateExecutiveSummary populates sources from opts", async () => {
  const generator = mockGenerator(async () => "Auth uses JWT tokens stored in Redis.");

  const summary = await generateExecutiveSummary(
    generator,
    "How does auth work?",
    [
      { concept: "auth-model", score: 0.9, content: "JWT auth flow" },
      { concept: "cache-layer", score: 0.8, content: "Redis cache" },
    ],
    2,
    undefined,
    undefined,
    {
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: false,
        hits_total: 0,
        files_considered: 0,
        mode: "always-on",
        reason: "no-hits",
        hits: [],
      },
      sources: [
        {
          concept: "auth-model",
          score: 0.9,
          files: ["src/auth/middleware.ts", "src/auth/jwt.ts"],
          staleness: 0.1,
          last_updated: "2026-02-01T00:00:00.000Z",
        },
        {
          concept: "cache-layer",
          score: 0.8,
          files: ["src/cache/redis.ts"],
          staleness: 0.2,
          last_updated: "2026-02-15T00:00:00.000Z",
        },
      ],
    },
  );

  expect(summary.kind).toBe("generated");
  expect(summary.sources).toHaveLength(2);
  expect(summary.sources[0]?.concept).toBe("auth-model");
  expect(summary.sources[1]?.concept).toBe("cache-layer");
  expect(summary.sources[0]?.files).toContain("src/auth/middleware.ts");
});

test("generateExecutiveSummary includes stale sources in structured data", async () => {
  const generator = mockGenerator(async () => "The payment system processes charges.");

  const summary = await generateExecutiveSummary(
    generator,
    "How do payments work?",
    [{ concept: "payment-flow", score: 0.85, content: "Payment processing" }],
    1,
    undefined,
    undefined,
    {
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: false,
        hits_total: 0,
        files_considered: 0,
        mode: "always-on",
        reason: "no-hits",
        hits: [],
      },
      sources: [
        {
          concept: "payment-flow",
          score: 0.85,
          files: ["src/payments/stripe.ts"],
          staleness: 0.7,
          last_updated: "2026-01-10T00:00:00.000Z",
        },
      ],
    },
  );

  expect(summary.kind).toBe("generated");
  expect(summary.sources[0]?.staleness).toBe(0.7);
});

test("generateExecutiveSummary returns per-term citations for non-exactness queries", async () => {
  const generator = mockGenerator(async () => "The auth middleware validates tokens using verifyJWT.\n- The cache uses invalidateSession for cleanup.");

  const summary = await generateExecutiveSummary(
    generator,
    "How does auth work?",
    [{ concept: "auth-model", score: 0.9, content: "JWT auth" }],
    1,
    undefined,
    undefined,
    {
      grounding: {
        enabled: true,
        attempted: true,
        exactness_detected: false,
        hits_total: 2,
        files_considered: 2,
        mode: "always-on",
        reason: "ok",
        hits: [
          {
            file: "src/auth/middleware.ts",
            line: 42,
            snippet: "export function verifyJWT(",
            term: "verifyJWT",
          },
          {
            file: "src/auth/session.ts",
            line: 18,
            snippet: "export function invalidateSession(",
            term: "invalidateSession",
          },
        ],
      },
    },
  );

  expect(summary.kind).toBe("generated");
  expect(summary.citations).toHaveLength(2);
  expect(summary.citations[0]?.term).toBe("verifyJWT");
  expect(summary.citations[1]?.term).toBe("invalidateSession");
  // Narrative should have LLM citations stripped (non-exactness)
  expect(summary.narrative).not.toMatch(/\[[^\]]+:\d+\]/);
});

test("generateExecutiveSummary includes journal trail and symbol results in user prompt", async () => {
  let capturedUser = "";

  const generator = mockGenerator(async (_system: string, user: string) => {
    capturedUser = user;
    return "Total debt uses GROUND_WEIGHT=0.6.\n- Formula divides by fiedler. [[debt-model]]";
  });

  const summary = await generateExecutiveSummary(
    generator,
    "What is the formula for total debt?",
    [
      {
        concept: "debt-model",
        score: 0.85,
        content: "Debt is computed from ground and lore residuals.",
      },
    ],
    1,
    undefined,
    undefined,
    {
      journalGroups: [
        {
          narrative_name: "benchmark-rationale-gaps",
          narrative_intent: "Investigate architectural rationale gaps",
          narrative_status: "closed",
          total_entries: 13,
          matched_entries: [
            {
              content: "GROUND_WEIGHT = 0.6, LORE_WEIGHT = 0.4 in residuals.ts:42-43",
              topics: ["debt", "residuals"],
              status: "finding",
              created_at: "2026-02-20T00:00:00.000Z",
              score: 0.15,
              entry_index: 3,
            },
            {
              content: "computeTotalDebt divides raw pressure by (1 + fiedlerValue)",
              topics: ["debt"],
              status: "finding",
              created_at: "2026-02-20T01:00:00.000Z",
              score: 0.12,
              entry_index: 5,
            },
          ],
          other_topics: ["architecture"],
          opened_at: "2026-02-20T00:00:00.000Z",
          closed_at: "2026-02-20T02:00:00.000Z",
        },
      ],
      symbolResults: [
        {
          symbol_id: "sym-1",
          file_path: "packages/core/src/engine/residuals.ts",
          name: "computeTotalDebt",
          qualified_name: "computeTotalDebt",
          kind: "function",
          signature: "function computeTotalDebt(...)",
          line_start: 81,
          line_end: 95,
          bound_concepts: ["debt-model"],
        },
        {
          symbol_id: "sym-2",
          file_path: "packages/core/src/engine/residuals.ts",
          name: "GROUND_WEIGHT",
          qualified_name: "GROUND_WEIGHT",
          kind: "function",
          signature: null,
          line_start: 42,
          line_end: 42,
        },
      ],
    },
  );

  expect(summary.kind).toBe("generated");
  // Journal trail should appear in the user prompt
  expect(capturedUser).toContain("Investigation trail");
  expect(capturedUser).toContain("benchmark-rationale-gaps");
  expect(capturedUser).toContain("GROUND_WEIGHT = 0.6");
  expect(capturedUser).toContain("Entry 3/13");
  expect(capturedUser).toContain("Entry 5/13");
  // Symbol results should appear
  expect(capturedUser).toContain("Symbol matches");
  expect(capturedUser).toContain("computeTotalDebt (function)");
  expect(capturedUser).toContain("residuals.ts:81");
  expect(capturedUser).toContain("Bound to: [debt-model]");
  expect(capturedUser).toContain("GROUND_WEIGHT (function)");
  // Counts should include journal entries
  expect(summary.counts.journal_entries).toBe(2);
  expect(summary.counts.concepts).toBe(1);
});
