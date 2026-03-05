#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkerClient } from "@lore/worker";
import { registerTools } from "./tools.ts";
import { registerResources } from "./resources.ts";

const server = new McpServer({
  name: "lore",
  version: "0.1.0",
});

const client = createWorkerClient();
registerResources(server, client);
registerTools(server, client);

const transport = new StdioServerTransport();
await server.connect(transport);
