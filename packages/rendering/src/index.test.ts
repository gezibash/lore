import { expect, test } from "bun:test";
import type { LsResult, StatusResult } from "@lore/worker";
import { renderLs, renderStatus } from "./index.ts";

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
