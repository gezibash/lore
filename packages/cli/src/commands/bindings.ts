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
  filePath?: string,
  line?: number,
): Promise<void> {
  const binding = await client.bindSymbol(concept, symbol, { confidence, filePath, line });
  console.log(
    `Bound ${binding.symbol_name} (${binding.symbol_kind}) → ${concept} [${binding.binding_type}, confidence: ${binding.confidence.toFixed(2)}]`,
  );
}

export async function conceptUnbindCommand(
  client: WorkerClient,
  concept: string,
  symbol: string,
  filePath?: string,
  line?: number,
): Promise<void> {
  const result = await client.unbindSymbol(
    concept,
    symbol,
    filePath || line !== undefined ? { filePath, line } : undefined,
  );
  if (!result.removed) {
    const at = [filePath ? ` in ${filePath}` : "", line !== undefined ? ` at line ${line}` : ""];
    const where = at.join("");
    console.log(`No binding found for ${concept} ↔ ${symbol}${where}`);
    return;
  }
  console.log(`Removed binding: ${concept} ↔ ${symbol}`);
}
