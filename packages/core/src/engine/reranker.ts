import { rerank } from "ai";
import { createCohere } from "@ai-sdk/cohere";
import { OPENROUTER_ATTRIBUTION } from "./provider.ts";
import type { LoreConfig } from "@/types/index.ts";

export interface RerankCandidate<T> {
  content: string;
  payload: T;
}

export interface RerankResult<T> {
  ordered: RerankCandidate<T>[];
  scores: number[]; // parallel to ordered — relevance score per candidate (0-1)
  failed: boolean;
  error?: string;
}

export async function rerankResults<T>(
  query: string,
  candidates: RerankCandidate<T>[],
  config: LoreConfig,
  opts?: { timeoutMs?: number },
): Promise<RerankResult<T>> {
  const rr = config.ai.search?.rerank;
  if (!rr?.enabled || candidates.length < 2) {
    return {
      ordered: candidates,
      scores: Array.from({ length: candidates.length }, () => 0),
      failed: false,
    };
  }

  const provider = rr.provider ?? "cohere";
  const modelName =
    rr.model ?? (provider === "openrouter" ? "voyageai/rerank-2.5-lite" : "rerank-v3.5");
  const maxChars = rr.max_chars ?? 4000;
  const topN = Math.min(rr.candidates ?? 20, candidates.length);
  const timeoutMs = opts?.timeoutMs;
  const timeoutAbort = timeoutMs && timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = timeoutAbort ? setTimeout(() => timeoutAbort.abort(), timeoutMs) : null;
  const documents = candidates.map((c) =>
    c.content.length > maxChars ? c.content.slice(0, maxChars) : c.content,
  );

  try {
    let ranking: Array<{ originalIndex: number; score: number }>;

    if (provider === "openrouter") {
      const baseUrl = (rr.base_url ?? "https://openrouter.ai/api/v1").replace(/\/+$/, "");
      const response = await fetch(`${baseUrl}/rerank`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${rr.api_key}`,
          // The rerank endpoint is a raw fetch, so it needs the same
          // attribution headers the SDK providers get. Without them
          // OpenRouter files the rerank calls under "Unknown".
          ...OPENROUTER_ATTRIBUTION,
        },
        body: JSON.stringify({ model: modelName, query, documents, top_n: topN }),
        ...(timeoutAbort ? { signal: timeoutAbort.signal } : {}),
      });
      if (!response.ok) {
        throw new Error(`openrouter rerank HTTP ${response.status}: ${await response.text()}`);
      }
      const body = (await response.json()) as {
        results?: Array<{ index: number; relevance_score: number }>;
      };
      ranking = (body.results ?? []).map((item) => ({
        originalIndex: item.index,
        score: item.relevance_score,
      }));
    } else {
      const client = createCohere({
        apiKey: rr.api_key,
        baseURL: rr.base_url,
      });
      const result = await rerank({
        model: client.rerankingModel(modelName),
        query,
        documents,
        topN,
        ...(timeoutAbort ? { abortSignal: timeoutAbort.signal } : {}),
      });
      ranking = result.ranking.map((item) => ({
        originalIndex: item.originalIndex,
        score: item.score,
      }));
    }

    const ordered: RerankCandidate<T>[] = [];
    const scores: number[] = [];
    for (const item of ranking) {
      const idx = item.originalIndex;
      if (idx >= 0 && idx < candidates.length) {
        ordered.push(candidates[idx]!);
        scores.push(item.score);
      }
    }

    // Append any candidates not present in ranking to preserve size
    if (ordered.length < candidates.length) {
      const seen = new Set(ordered.map((c) => c));
      for (const c of candidates) {
        if (!seen.has(c)) {
          ordered.push(c);
          scores.push(0);
        }
      }
    }

    return {
      ordered: ordered.slice(0, candidates.length),
      scores: scores.slice(0, candidates.length),
      failed: false,
    };
  } catch (error) {
    const timedOut = Boolean(
      timeoutAbort &&
      timeoutAbort.signal.aborted &&
      error instanceof Error &&
      (error.name === "AbortError" ||
        error.name === "TimeoutError" ||
        /aborted/i.test(error.message)),
    );
    return {
      ordered: candidates,
      scores: Array.from({ length: candidates.length }, () => 0),
      failed: true,
      error: timedOut
        ? `rerank timed out after ${timeoutMs}ms`
        : error instanceof Error
          ? error.message
          : "rerank failed",
    };
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
