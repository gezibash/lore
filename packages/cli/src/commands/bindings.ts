import type { WorkerClient } from "@lore/worker";
import { formatConceptBindingsCli } from "../formatters.ts";
import { emit } from "../output.ts";

export async function conceptBindingsCommand(client: WorkerClient, concept: string): Promise<void> {
  const bindings = await client.conceptBindings(concept);
  emit({ concept, bindings }, (value) => formatConceptBindingsCli(value.concept, value.bindings));
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
  emit(
    binding,
    (value) =>
      `Bound ${value.symbol_name} (${value.symbol_kind}) → ${concept} [${value.binding_type}, confidence: ${value.confidence.toFixed(2)}]`,
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
  const at = [filePath ? ` in ${filePath}` : "", line !== undefined ? ` at line ${line}` : ""];
  const where = at.join("");
  emit(result, (value) =>
    value.removed
      ? `Removed binding: ${concept} ↔ ${symbol}`
      : `No binding found for ${concept} ↔ ${symbol}${where}`,
  );
}
