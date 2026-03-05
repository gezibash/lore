#!/usr/bin/env bun
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWorkerClient, type WorkerClient } from "@lore/worker";
import { registerTools } from "./tools.ts";
import { registerResources } from "./resources.ts";

export interface StartMcpServerOptions {
  client?: WorkerClient;
}

export function createMcpServer(client: WorkerClient = createWorkerClient()): McpServer {
  const server = new McpServer({
    name: "lore",
    version: "0.1.0",
  });

  registerResources(server, client);
  registerTools(server, client);

  return server;
}

export async function startMcpServer(options?: StartMcpServerOptions): Promise<McpServer> {
  const server = createMcpServer(options?.client ?? createWorkerClient());
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return server;
}

if (import.meta.main) {
  await startMcpServer();
}
