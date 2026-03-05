import { resolve } from "path";
import type { WorkerClient } from "@lore/worker";
import { formatRegisterCli } from "../formatters.ts";
import { ensureProjectMcpConfig, type EnsureProjectMcpConfigOptions } from "./mcp-config.ts";

export async function registerCommand(
  client: WorkerClient,
  path?: string,
  name?: string,
  mcp?: EnsureProjectMcpConfigOptions,
): Promise<void> {
  const codePath = resolve(path ?? process.cwd());
  const result = await client.register(codePath, name);
  const mcpResult =
    mcp?.harnesses && mcp.harnesses.length > 0
      ? await ensureProjectMcpConfig(codePath, mcp)
      : undefined;
  console.log(formatRegisterCli(codePath, result.lore_path, mcpResult));
}
