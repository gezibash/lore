import type { EmbeddingModel, LanguageModel } from "ai";
import { LoreError } from "@/types/index.ts";
import type { EmbeddingProvider, LoreConfig } from "@/types/index.ts";

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

export interface EmbeddingProviderConfig {
  provider: EmbeddingProvider;
  model: string;
  base_url?: string;
  api_key?: string;
}

/**
 * OpenRouter attributes usage to an app by URL, not by name.
 *
 * HTTP-Referer is what creates the app entry; a title on its own is ignored and
 * the calls land under "Unknown". The referer is lore's repository because that
 * is the app making the call. The title is a constant for the same reason: the
 * lore being served is a project of the user's, not a separate app, and letting
 * it through would rename the one app page on every run.
 *
 * X-OpenRouter-Title is the current header. X-Title still works and is sent too,
 * so attribution survives either end of the rename. The title is the display
 * name in the rankings, so it is capitalised; the command stays lowercase.
 */
/**
 * openai-compatible has no default endpoint: the base URL is the whole point of
 * the provider. Without this check the URL reaches the SDK as undefined and the
 * first request goes to "undefined/chat/completions", which fails as a network
 * error naming nothing the reader can act on.
 */
function requireBaseUrl(baseUrl: string | undefined, role: "embedding" | "generation"): string {
  if (baseUrl) return baseUrl;
  throw new LoreError(
    "CONFIG_INVALID",
    `Provider 'openai-compatible' needs a base URL. Set one with: lore sys config set ai.${role}.base_url <url>`,
  );
}

export const OPENROUTER_ATTRIBUTION = {
  "HTTP-Referer": "https://github.com/gezibash/lore",
  "X-OpenRouter-Title": "Lore",
  "X-Title": "Lore",
};

export async function createEmbeddingModelFromProviderConfig(
  config: EmbeddingProviderConfig,
): Promise<EmbeddingModel> {
  const { provider, model, base_url, api_key } = config;
  switch (provider) {
    case "ollama": {
      const { createOllama } = await import("ollama-ai-provider-v2");
      const ollamaBaseUrl = stripTrailingSlashes(base_url ?? "http://localhost:11434");
      return createOllama({ baseURL: `${ollamaBaseUrl}/api` }).embeddingModel(model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: api_key }).embedding(model);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        baseURL: requireBaseUrl(base_url, "embedding"),
        apiKey: api_key,
        name: "custom",
      }).textEmbeddingModel(model);
    }
    case "gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      return createGateway({ apiKey: api_key }).textEmbeddingModel(model);
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const openrouterBaseUrl = stripTrailingSlashes(base_url ?? "https://openrouter.ai/api/v1");
      return createOpenAICompatible({
        baseURL: openrouterBaseUrl,
        apiKey: api_key,
        name: "openrouter",
        headers: OPENROUTER_ATTRIBUTION,
      }).textEmbeddingModel(model);
    }
    case "voyage": {
      const { createVoyage } = await import("voyage-ai-provider");
      return createVoyage({ apiKey: api_key }).textEmbeddingModel(model);
    }
    default:
      throw new Error(`Unknown embedding provider: ${provider}`);
  }
}

export async function createEmbeddingModel(config: LoreConfig): Promise<EmbeddingModel> {
  return createEmbeddingModelFromProviderConfig(config.ai.embedding);
}

export async function createGenerationModel(config: LoreConfig): Promise<LanguageModel> {
  const { provider, model, base_url, api_key } = config.ai.generation;
  switch (provider) {
    case "ollama": {
      const { createOllama } = await import("ollama-ai-provider-v2");
      const ollamaBaseUrl = stripTrailingSlashes(base_url ?? "http://localhost:11434");
      return createOllama({ baseURL: `${ollamaBaseUrl}/api` })(model);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: api_key })(model);
    }
    case "groq": {
      const { createGroq } = await import("@ai-sdk/groq");
      return createGroq({ apiKey: api_key })(model);
    }
    case "openai-compatible": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      return createOpenAICompatible({
        baseURL: requireBaseUrl(base_url, "generation"),
        apiKey: api_key,
        name: "custom",
      }).chatModel(model);
    }
    case "gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      return createGateway({ apiKey: api_key })(model);
    }
    case "openrouter": {
      const { createOpenAICompatible } = await import("@ai-sdk/openai-compatible");
      const openrouterBaseUrl = stripTrailingSlashes(base_url ?? "https://openrouter.ai/api/v1");
      return createOpenAICompatible({
        baseURL: openrouterBaseUrl,
        apiKey: api_key,
        name: "openrouter",
        headers: OPENROUTER_ATTRIBUTION,
      }).chatModel(model);
    }
    case "codex": {
      const { createCodexLanguageModel } = await import("./codex-provider.ts");
      return createCodexLanguageModel(model, {
        binPath: config.ai.generation.codex_bin,
        reasoningEffort: config.ai.generation.codex_reasoning_effort ?? "low",
        serviceTier: config.ai.generation.codex_service_tier,
      });
    }
    case "moonshotai": {
      const { createMoonshotAI } = await import("@ai-sdk/moonshotai");
      return createMoonshotAI({
        apiKey: api_key,
        ...(base_url ? { baseURL: base_url } : {}),
      })(model);
    }
    case "alibaba": {
      const { createAlibaba } = await import("@ai-sdk/alibaba");
      return createAlibaba({
        apiKey: api_key,
        ...(base_url ? { baseURL: base_url } : {}),
      })(model);
    }
    default:
      throw new Error(`Unknown generation provider: ${provider}`);
  }
}
