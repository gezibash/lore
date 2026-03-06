import { resolve } from "path";
import type { WorkerClient } from "@lore/worker";
import { formatRegisterCli } from "../formatters.ts";

export async function registerCommand(
  client: WorkerClient,
  path?: string,
  name?: string,
): Promise<void> {
  const codePath = resolve(path ?? process.cwd());
  const result = await client.register(codePath, name);
  console.log(formatRegisterCli(codePath, result.lore_path));
}
