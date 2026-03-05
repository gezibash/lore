import { expect, test } from "bun:test";
import { LoreEngine } from "./index.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";
import type { LoreConfig } from "@/types/index.ts";

test("shared provider credentials fill missing lore mind API keys and base URLs", async () => {
  const loreRoot = createTempDir("lore-root-");
  const loreMindPath = createTempDir("lore-mind-");

  const engine = new LoreEngine({
    lore_root: loreRoot,
    ai: {
      embedding: {
        base_url: "http://localhost:11434",
      },
    },
  } as Partial<LoreConfig>);

  try {
    await engine.register(loreMindPath, "demo");
    engine.setProviderCredential("openrouter", {
      api_key: "sk-shared-openrouter",
      base_url: "https://openrouter.ai/api/v1",
    });
    engine.setProviderCredential("cohere", {
      api_key: "co-shared",
    });

    engine.setLoreMindConfig("ai.embedding.provider", "openrouter", { codePath: loreMindPath });
    engine.setLoreMindConfig("ai.embedding.model", "qwen/qwen3-embedding-8b", {
      codePath: loreMindPath,
    });
    engine.setLoreMindConfig("ai.search.rerank.enabled", true, { codePath: loreMindPath });

    const resolved = engine.getLoreMindConfig({ codePath: loreMindPath }).resolved;
    expect(resolved.ai.embedding.api_key).toBe("sk-shared-openrouter");
    expect(resolved.ai.embedding.base_url).toBe("https://openrouter.ai/api/v1");
    expect(resolved.ai.search?.rerank?.api_key).toBe("co-shared");
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(loreMindPath);
  }
});

test("lore mind API key overrides shared provider credentials", async () => {
  const loreRoot = createTempDir("lore-root-");
  const loreMindPath = createTempDir("lore-mind-");

  const engine = new LoreEngine({ lore_root: loreRoot });

  try {
    await engine.register(loreMindPath, "demo");
    engine.setProviderCredential("openrouter", {
      api_key: "sk-shared-openrouter",
    });

    engine.setLoreMindConfig("ai.embedding.provider", "openrouter", { codePath: loreMindPath });
    engine.setLoreMindConfig("ai.embedding.model", "qwen/qwen3-embedding-8b", {
      codePath: loreMindPath,
    });
    engine.setLoreMindConfig("ai.embedding.api_key", "sk-lore-openrouter", {
      codePath: loreMindPath,
    });

    const resolved = engine.getLoreMindConfig({ codePath: loreMindPath }).resolved;
    expect(resolved.ai.embedding.api_key).toBe("sk-lore-openrouter");
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(loreMindPath);
  }
});

test("executive summary provider can resolve credentials separately from generation", async () => {
  const loreRoot = createTempDir("lore-root-");
  const loreMindPath = createTempDir("lore-mind-");

  const engine = new LoreEngine({ lore_root: loreRoot });

  try {
    await engine.register(loreMindPath, "demo");
    engine.setProviderCredential("openrouter", {
      api_key: "sk-openrouter-summary",
      base_url: "https://openrouter.ai/api/v1",
    });
    engine.setProviderCredential("gateway", {
      api_key: "vck-generation",
    });

    engine.setLoreMindConfig("ai.generation.provider", "gateway", { codePath: loreMindPath });
    engine.setLoreMindConfig("ai.generation.model", "minimax/minimax-m2.5", {
      codePath: loreMindPath,
    });
    engine.setLoreMindConfig("ai.search.executive_summary.provider", "openrouter", {
      codePath: loreMindPath,
    });
    engine.setLoreMindConfig("ai.search.executive_summary.model", "moonshotai/kimi-k2.5", {
      codePath: loreMindPath,
    });

    const resolved = engine.getLoreMindConfig({ codePath: loreMindPath }).resolved;
    expect(resolved.ai.generation.api_key).toBe("vck-generation");
    expect(resolved.ai.search?.executive_summary?.api_key).toBe("sk-openrouter-summary");
    expect(resolved.ai.search?.executive_summary?.base_url).toBe("https://openrouter.ai/api/v1");
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(loreMindPath);
  }
});
