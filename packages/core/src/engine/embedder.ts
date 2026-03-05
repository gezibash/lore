import { embed, embedMany, type EmbeddingModel } from "ai";
import { LoreError } from "@/types/index.ts";
import type { LoreConfig } from "@/types/index.ts";
import { createEmbeddingModel, createEmbeddingModelFromProviderConfig } from "./provider.ts";
import type { EmbeddingProviderConfig } from "./provider.ts";

export class Embedder {
  private model: EmbeddingModel;

  private constructor(model: EmbeddingModel) {
    this.model = model;
  }

  static async create(config: LoreConfig, appName?: string): Promise<Embedder> {
    const model = await createEmbeddingModel(config, appName);
    return new Embedder(model);
  }

  static async createForCode(config: LoreConfig, appName?: string): Promise<Embedder | null> {
    const code = config.ai.embedding.code;
    if (!code) return null;
    const resolved: EmbeddingProviderConfig = {
      provider: code.provider ?? config.ai.embedding.provider,
      model: code.model,
      base_url: code.base_url ?? config.ai.embedding.base_url,
      api_key: code.api_key ?? config.ai.embedding.api_key,
    };
    const model = await createEmbeddingModelFromProviderConfig(resolved, appName);
    return new Embedder(model);
  }

  async embed(text: string, opts?: { timeoutMs?: number }): Promise<Float32Array> {
    const timeoutMs = opts?.timeoutMs;
    const timeoutAbort = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
    const timeoutId = timeoutAbort ? setTimeout(() => timeoutAbort.abort(), timeoutMs) : null;
    try {
      const { embedding } = await embed({
        model: this.model,
        value: text,
        ...(timeoutAbort ? { abortSignal: timeoutAbort.signal } : {}),
      });
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
      const { embeddings } = await embedMany({ model: this.model, values: texts });
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
