import { existsSync } from "node:fs";
import { resolve, join } from "path";
import type { WorkerClient } from "@lore/worker";
import { formatRegisterCli } from "../formatters.ts";
import { installHook, type InstallOutcome } from "../hooks.ts";
import { emit } from "../output.ts";

export async function registerCommand(
  client: WorkerClient,
  path?: string,
  name?: string,
  opts?: { hooks?: boolean },
): Promise<void> {
  const codePath = resolve(path ?? process.cwd());
  const result = await client.register(codePath, name);
  const hasLoreignore = existsSync(join(codePath, ".loreignore"));
  let hook: InstallOutcome | undefined;
  if (opts?.hooks) {
    hook = installHook({ cwd: codePath });
  }
  emit(
    {
      code_path: codePath,
      lore_path: result.lore_path,
      has_loreignore: hasLoreignore,
      hook,
    },
    formatRegisterCli,
  );
}
