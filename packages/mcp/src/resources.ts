import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkerClient } from "@lore/worker";

export function registerResources(server: McpServer, client: WorkerClient): void {
  server.registerResource(
    "concepts_list",
    "lore://concepts/list",
    {
      title: "Current Concepts",
      description: "Active concepts that represent the current truth for the selected lore",
      mimeType: "application/json",
    },
    async (uri) => {
      const result = await client.ls();
      const payload = {
        lore: result.lore_mind.name,
        generated_at: new Date().toISOString(),
        concept_count: result.concepts.length,
        debt: result.debt,
        debt_trend: result.debt_trend,
        concepts: result.concepts.map((concept) => ({
          name: concept.name,
          residual: concept.residual,
          churn: concept.churn,
          ground_residual: concept.ground_residual,
          lore_residual: concept.lore_residual,
          staleness: concept.staleness,
          cluster: concept.cluster,
        })),
      };

      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  server.registerResource(
    "coverage_map",
    "lore://coverage/map",
    {
      title: "Coverage Map",
      description: "Symbol coverage stats showing which code the lore mind covers",
      mimeType: "application/json",
    },
    async (uri) => {
      const report = client.coverageReport({ limit: 50 });
      return {
        contents: [
          {
            uri: uri.toString(),
            mimeType: "application/json",
            text: JSON.stringify(report, null, 2),
          },
        ],
      };
    },
  );
}
