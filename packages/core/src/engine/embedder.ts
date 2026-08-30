import { embed, embedMany, type EmbeddingModel } from "ai";
import { LoreError } from "@/types/index.ts";
import type { LoreConfig } from "@/types/index.ts";
import { createEmbeddingModel, createEmbeddingModelFromProviderConfig } from "./provider.ts";
import type { EmbeddingProviderConfig } from "./provider.ts";
import type { UsageReporter } from "@/db/usage.ts";

/** Providers reject inputs past their context limit (e.g. 131,072 chars for
 *  qwen3-embedding via OpenRouter). Truncate here — the boundary — so every
 *  embed call path is protected; retrieval on a truncated head beats a 422. */
const MAX_EMBED_CHARS = 100_000;

function clip(text: string): string {
  return text.length > MAX_EMBED_CHARS ? text.slice(0, MAX_EMBED_CHARS) : text;
}

export class Embedder {
  private model: EmbeddingModel;
  private readonly provider: string;
  private readonly modelName: string;
  private readonly onUsage?: UsageReporter;

  private constructor(
    model: EmbeddingModel,
    provider: string,
    modelName: string,
    onUsage?: UsageReporter,
  ) {
    this.model = model;
    this.provider = provider;
    this.modelName = modelName;
    this.onUsage = onUsage;
  }

  /**
   * Embedding responses carry a token count for the input only; there is no
   * output side to charge for.
   */
  private report(operation: string, tokens: number | undefined): void {
    if (tokens === undefined) return;
    this.onUsage?.({
      kind: "embedding",
      operation,
      provider: this.provider,
      model: this.modelName,
      input_tokens: tokens,
      output_tokens: 0,
    });
  }

  static async create(config: LoreConfig, onUsage?: UsageReporter): Promise<Embedder> {
    const model = await createEmbeddingModel(config);
    return new Embedder(model, config.ai.embedding.provider, config.ai.embedding.model, onUsage);
  }

  static async createForCode(
    config: LoreConfig,
    onUsage?: UsageReporter,
  ): Promise<Embedder | null> {
    const code = config.ai.embedding.code;
    if (!code) return null;
    const resolved: EmbeddingProviderConfig = {
      provider: code.provider ?? config.ai.embedding.provider,
      model: code.model,
      base_url: code.base_url ?? config.ai.embedding.base_url,
      api_key: code.api_key ?? config.ai.embedding.api_key,
    };
    const model = await createEmbeddingModelFromProviderConfig(resolved);
    return new Embedder(model, resolved.provider, resolved.model, onUsage);
  }

  async embed(text: string, opts?: { timeoutMs?: number }): Promise<Float32Array> {
    const timeoutMs = opts?.timeoutMs;
    const timeoutAbort = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = timeoutAbort ? setTimeout(() => timeoutAbort.abort(), timeoutMs) : null;
    try {
      const { embedding, usage } = await embed({
        model: this.model,
        value: clip(text),
        ...(timeoutAbort ? { abortSignal: timeoutAbort.signal } : {}),
      });
      this.report("embed", usage?.tokens);
      return Float32Array.from(embedding);
    } catch (error) {
      const timedOut = Boolean(
        timeoutAbort &&
        timeoutAbort.signal.aborted &&
        error instanceof Error &&
        (error.name === "AbortError" ||
          error.name === "TimeoutError" ||
          /aborted/i.test(error.message)),
      );
      const timeoutNote = timedOut ? ` (timed out after ${timeoutMs}ms)` : "";
      throw new LoreError(
        "AI_UNAVAILABLE",
        `Failed to embed text${timeoutNote}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    try {
      const { embeddings, usage } = await embedMany({
        model: this.model,
        values: texts.map(clip),
      });
      this.report("embed_batch", usage?.tokens);
      return embeddings.map((e) => Float32Array.from(e));
    } catch (error) {
      throw new LoreError(
        "AI_UNAVAILABLE",
        `Failed to batch embed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      await embed({ model: this.model, value: "test" });
      return true;
    } catch {
      return false;
    }
  }
}
