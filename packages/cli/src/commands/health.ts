import type { WorkerClient } from "@lore/worker";
import {
  formatConceptHealthComputeCli,
  formatConceptHealthExplainCli,
  formatHealConceptsCli,
} from "../formatters.ts";

export async function healthComputeCommand(client: WorkerClient, top?: number): Promise<void> {
  const result = await client.computeConceptHealth({ top });
  console.log(formatConceptHealthComputeCli(result));
}

export async function healthExplainCommand(
  client: WorkerClient,
  concept: string,
  opts?: { neighborLimit?: number; recompute?: boolean },
): Promise<void> {
  const result = await client.explainConceptHealth(concept, opts);
  console.log(formatConceptHealthExplainCli(result));
}

export async function healthHealCommand(
  client: WorkerClient,
  opts?: {
    threshold?: number;
    limit?: number;
    dry?: boolean;
  },
): Promise<void> {
  const result = await client.healConcepts(opts);
  console.log(formatHealConceptsCli(result));
}
