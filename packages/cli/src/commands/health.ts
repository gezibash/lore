import type { WorkerClient } from "@lore/worker";
import {
  formatConceptHealthComputeCli,
  formatConceptHealthExplainCli,
  formatHealConceptsCli,
} from "../formatters.ts";
import { emit } from "../output.ts";

export async function healthComputeCommand(client: WorkerClient, top?: number): Promise<void> {
  const result = await client.computeConceptHealth({ top });
  emit(result, formatConceptHealthComputeCli);
}

export async function healthExplainCommand(
  client: WorkerClient,
  concept: string,
  opts?: { neighborLimit?: number; recompute?: boolean },
): Promise<void> {
  const result = await client.explainConceptHealth(concept, opts);
  emit(result, formatConceptHealthExplainCli);
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
  emit(result, formatHealConceptsCli);
}
