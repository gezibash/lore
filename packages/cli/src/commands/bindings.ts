import type { WorkerClient } from "@lore/worker";
import { formatConceptBindingsCli } from "../formatters.ts";

export async function conceptBindingsCommand(client: WorkerClient, concept: string): Promise<void> {
  const bindings = await client.conceptBindings(concept);
  console.log(formatConceptBindingsCli(concept, bindings));
}

export async function conceptBindCommand(
  client: WorkerClient,
  concept: string,
  symbol: string,
  confidence?: number,
): Promise<void> {
  const binding = await client.bindSymbol(concept, symbol, { confidence });
  console.log(
    `Bound ${binding.symbol_name} (${binding.symbol_kind}) → ${concept} [${binding.binding_type}, confidence: ${binding.confidence.toFixed(2)}]`,
  );
}

export async function conceptUnbindCommand(
  client: WorkerClient,
  concept: string,
  symbol: string,
): Promise<void> {
  const result = await client.unbindSymbol(concept, symbol);
  if (!result.removed) {
    console.log(`No binding found for ${concept} ↔ ${symbol}`);
    return;
  }
  console.log(`Removed binding: ${concept} ↔ ${symbol}`);
}
