import type { EmbeddingModel, LanguageModel } from "ai";
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

export async function createEmbeddingModelFromProviderConfig(
  config: EmbeddingProviderConfig,
  appName?: string,
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
        baseURL: base_url!,
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
        headers: { "X-Title": appName ?? "lore" },
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

export async function createEmbeddingModel(config: LoreConfig, appName?: string): Promise<EmbeddingModel> {
  return createEmbeddingModelFromProviderConfig(config.ai.embedding, appName);
}

export async function createGenerationModel(config: LoreConfig, appName?: string): Promise<LanguageModel> {
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
        baseURL: base_url!,
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
        headers: { "X-Title": appName ?? "lore" },
      }).chatModel(model);
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
