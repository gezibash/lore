import type { WorkerClient } from "@lore/worker";
import { createProgressBar } from "boune";

export async function refreshEmbeddingsCommand(client: WorkerClient): Promise<void> {
  const bars: {
    text: ReturnType<typeof createProgressBar> | null;
    code: ReturnType<typeof createProgressBar> | null;
  } = { text: null, code: null };

  let codeError: string | null = null;
  let textModelSeen: string | null = null;
  let codeModelSeen: string | null = null;
  let finalTextTotal = 0;

  const result = await client.reEmbed({
    onProgress(phase, current, total, model) {
      if (phase === "text") {
        if (model && !textModelSeen) textModelSeen = model;
        const label = `Embedding [text${model ? ` · ${model}` : ""}]`;
        if (!bars.text) bars.text = createProgressBar(label, { total });
        bars.text.update(current, label);
        finalTextTotal = total;
      } else if (phase === "code") {
        if (model && !codeModelSeen) codeModelSeen = model;
        const label = `Embedding [code${model ? ` · ${model}` : ""}]`;
        if (!bars.code) {
          bars.code = createProgressBar(label, { total });
        }
        bars.code.update(current, label);
      }
    },
  }).catch((err: unknown) => {
    codeError = err instanceof Error ? err.message : String(err);
    return null;
  });

  if (result) {
    const textLabel = `Embedding [text · ${result.textModel}]`;
    const codeLabel = result.codeModel ? `Embedding [code · ${result.codeModel}]` : "Embedding [code]";
    bars.text?.complete(`${textLabel} — ${result.reEmbedded} chunks done`);
    bars.code?.complete(`${codeLabel} — ${result.codeEmbedded} chunks done`);

    const parts = [`${result.reEmbedded} text (${result.textModel})`];
    if (result.codeEmbedded > 0) parts.push(`${result.codeEmbedded} code (${result.codeModel})`);
    if (result.deleted > 0) parts.push(`${result.deleted} .emb files removed`);
    console.log(`Refreshed: ${parts.join(", ")}`);
  } else {
    bars.text?.complete(`Embedding [text] — ${finalTextTotal} chunks done`);
    bars.code?.fail(`Embedding [code] — failed`);
    console.error(`error: ${codeError}`);
    process.exit(1);
  }
}
