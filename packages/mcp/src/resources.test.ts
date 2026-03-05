import { expect, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkerClient } from "@lore/worker";
import { registerResources } from "./resources.ts";

test("registerResources exposes lore concepts list resource", async () => {
  const registrations: Array<{
    name: string;
    uri: string;
    config: { title?: string; description?: string; mimeType?: string };
    read: (
      uri: URL,
    ) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>;
  }> = [];

  const server = {
    registerResource(
      name: string,
      uri: string,
      config: { title?: string; description?: string; mimeType?: string },
      read: (
        uri: URL,
      ) => Promise<{ contents: Array<{ uri: string; mimeType?: string; text: string }> }>,
    ) {
      registrations.push({ name, uri, config, read });
      return {};
    },
  } as unknown as McpServer;

  const engine = {
    async ls() {
      return {
        lore_mind: { name: "demo" },
        concepts: [{ name: "auth-model", residual: 0.2, staleness: 0.1, cluster: 1 }],
        manifest: null,
        openNarratives: [],
        debt: 0.42,
        debt_trend: "stable, live ref drift",
      };
    },
    coverageReport() {
      return {
        stats: { total_symbols: 10, total_exported: 8, bound_symbols: 5, bound_exported: 4 },
        coverage_ratio: 0.5,
        files: [],
        uncovered: [],
      };
    },
  } as unknown as WorkerClient;

  registerResources(server, engine);

  const registered = registrations.find((r) => r.name === "concepts_list");
  expect(registered).toBeDefined();
  expect(registered!.uri).toBe("lore://concepts/list");
  expect(registered!.config.mimeType).toBe("application/json");

  const read = await registered!.read(new URL("lore://concepts/list"));
  expect(read.contents.length).toBe(1);
  expect(read.contents[0]?.uri).toBe("lore://concepts/list");
  expect(read.contents[0]?.mimeType).toBe("application/json");

  const payload = JSON.parse(read.contents[0]!.text) as {
    lore: string;
    concept_count: number;
    debt: number;
    debt_trend: string;
    concepts: Array<{ name: string }>;
  };
  expect(payload.lore).toBe("demo");
  expect(payload.concept_count).toBe(1);
  expect(payload.debt).toBe(0.42);
  expect(payload.debt_trend).toBe("stable, live ref drift");
  expect(payload.concepts[0]?.name).toBe("auth-model");

  // Verify coverage_map resource is also registered
  const coverageReg = registrations.find((r) => r.name === "coverage_map");
  expect(coverageReg).toBeDefined();
  expect(coverageReg!.uri).toBe("lore://coverage/map");
  const coverageRead = await coverageReg!.read(new URL("lore://coverage/map"));
  expect(coverageRead.contents.length).toBe(1);
  const coveragePayload = JSON.parse(coverageRead.contents[0]!.text);
  expect(coveragePayload.coverage_ratio).toBe(0.5);
});
