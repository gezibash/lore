import { join } from "path";
import { homedir } from "os";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { LoreConfig } from "@/types/index.ts";
import { defaultGenerationPrompts, mergeGenerationPrompts } from "./prompts.ts";

const LORE_ROOT = join(homedir(), ".lore");
const GLOBAL_CONFIG_PATH = join(LORE_ROOT, "config.json");

export const defaultConfig: LoreConfig = {
  lore_root: LORE_ROOT,
  ai: {
    embedding: {
      provider: "ollama",
      model: "qwen3-embedding:8b",
      dim: 4096,
    },
    generation: {
      provider: "ollama",
      model: "qwen3:8b",
      reasoning: "none",
      prompts: mergeGenerationPrompts(defaultGenerationPrompts, undefined),
    },
    search: {
      exa_api_key: process.env.EXA_API_KEY,
      context7_api_key: process.env.CONTEXT7_API_KEY,
      retrieval: {
        return_limit: 20,
        vector_limit: 100,
        journal_group_limit: 10,
        journal_entries_per_group: 3,
      },
      timeouts: {
        embedding_ms: 30000,
        rerank_ms: 15000,
        executive_summary_ms: 30000,
      },
      rerank: {
        enabled: false,
        model: "rerank-v3.5",
        candidates: 20,
        max_chars: 4000,
        api_key: process.env.COHERE_API_KEY,
        min_relevance: 0,
      },
      executive_summary: {
        enabled: true,
        max_matches: 6,
        max_chars: 1600,
      },
      retrieval_opts: {
        max_grounding_hits: 8,
        freshness_decay_days: 7,
        ppr_fusion_alpha: 0.2,
      },
    },
  },
  chunking: {
    target_tokens: 900,
    overlap: 0.15,
  },
  thresholds: {
    convergence: 0.85,
    magnitude_epsilon: 0.3,
    staleness_days: 47,
    dangling_days: 3,
    conflict_warn: 0.3,
    theta_mixed: 45,
    theta_critical: 70,
    fiedler_drop: 0.1,
    max_log_n: 9,
  },
  rrf: {
    k: 60,
    lane_weights: [1.0, 1.0], // [text, bm25]
  },
  debug: {
    ask: {
      trace: false,
    },
  },
};

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

function deepMerge(base: LoreConfig, overrides: DeepPartial<LoreConfig>): LoreConfig {
  const generationOverrides = overrides.ai?.generation as
    | (DeepPartial<LoreConfig["ai"]["generation"]> & { prompts?: unknown })
    | undefined;

  return {
    ...base,
    ...overrides,
    ai: {
      embedding: { ...base.ai.embedding, ...overrides.ai?.embedding },
      generation: {
        ...base.ai.generation,
        ...overrides.ai?.generation,
        reasoning_overrides: {
          ...base.ai.generation.reasoning_overrides,
          ...overrides.ai?.generation?.reasoning_overrides,
        },
        prompts: mergeGenerationPrompts(base.ai.generation.prompts, generationOverrides?.prompts),
      },
      search: {
        ...base.ai.search,
        ...overrides.ai?.search,
        retrieval: {
          ...base.ai.search?.retrieval,
          ...overrides.ai?.search?.retrieval,
        },
        timeouts: {
          ...base.ai.search?.timeouts,
          ...overrides.ai?.search?.timeouts,
        },
        rerank: {
          ...base.ai.search?.rerank,
          ...overrides.ai?.search?.rerank,
        },
        executive_summary: {
          ...base.ai.search?.executive_summary,
          ...overrides.ai?.search?.executive_summary,
        },
        retrieval_opts: {
          ...base.ai.search?.retrieval_opts,
          ...overrides.ai?.search?.retrieval_opts,
        },
      },
    },
    chunking: { ...base.chunking, ...overrides.chunking },
    thresholds: { ...base.thresholds, ...overrides.thresholds },
    rrf: { ...base.rrf, ...overrides.rrf },
  } as LoreConfig;
}

function loadJsonConfig(path: string): DeepPartial<LoreConfig> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return {};
  }
}

/**
 * Resolve config with layered precedence:
 *   hardcoded defaults < ~/.lore/config.json < <codepath>/.lore/config.json < programmatic overrides
 */
export function resolveConfig(
  overrides?: Partial<LoreConfig>,
  loreMindConfig?: Partial<LoreConfig>,
): LoreConfig {
  // Layer 1: hardcoded defaults
  let config = { ...defaultConfig };

  // Layer 2: global config file (~/.lore/config.json)
  const globalOverrides = loadJsonConfig(GLOBAL_CONFIG_PATH);
  config = deepMerge(config, globalOverrides);

  // Layer 3: per-lore-mind config from registry
  if (loreMindConfig) {
    config = deepMerge(config, loreMindConfig);
  }

  // Layer 4: programmatic overrides
  if (overrides) {
    config = deepMerge(config, overrides);
  }

  return config;
}

/**
 * Write a global config file at ~/.lore/config.json
 */
export function writeGlobalConfig(config: DeepPartial<LoreConfig>): void {
  mkdirSync(LORE_ROOT, { recursive: true });
  writeFileSync(GLOBAL_CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

/** Path to the per-project local config inside the codebase. */
export function localConfigPath(codePath: string): string {
  return join(codePath, ".lore", "config.json");
}

/** Load per-project config from <codePath>/.lore/config.json. Returns {} if absent. */
export function loadLocalConfig(codePath: string): DeepPartial<LoreConfig> {
  return loadJsonConfig(localConfigPath(codePath));
}

/** Write per-project config to <codePath>/.lore/config.json. Creates .lore/ dir if needed. */
export function writeLocalConfig(codePath: string, config: DeepPartial<LoreConfig>): void {
  const dir = join(codePath, ".lore");
  mkdirSync(dir, { recursive: true });
  writeFileSync(localConfigPath(codePath), JSON.stringify(config, null, 2) + "\n");
}

/** Seed ~/.lore/config.json with readable defaults if it doesn't already exist. */
export function seedGlobalConfigIfAbsent(): void {
  if (existsSync(GLOBAL_CONFIG_PATH)) return;
  const seed: DeepPartial<LoreConfig> = {
    ai: {
      embedding: {
        provider: defaultConfig.ai.embedding.provider,
        model: defaultConfig.ai.embedding.model,
        dim: defaultConfig.ai.embedding.dim,
      },
      generation: {
        provider: defaultConfig.ai.generation.provider,
        model: defaultConfig.ai.generation.model,
      },
    },
    chunking: { ...defaultConfig.chunking },
    thresholds: { ...defaultConfig.thresholds },
    rrf: { k: defaultConfig.rrf.k },
  };
  writeGlobalConfig(seed);
}

// Deep path utilities for config get/set/unset

export function getDeepValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function setDeepValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (current[key] == null || typeof current[key] !== "object") {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]!] = value;
}

export function deleteDeepValue(obj: Record<string, unknown>, path: string): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i]!;
    if (current[key] == null || typeof current[key] !== "object") return;
    current = current[key] as Record<string, unknown>;
  }
  delete current[keys[keys.length - 1]!];
}

export function loreMindPath(loreMindName: string, root?: string): string {
  return join(root ?? LORE_ROOT, "minds", loreMindName);
}

export const EMBEDDING_DIM = defaultConfig.ai.embedding.dim;
export const EMBEDDING_BYTES = EMBEDDING_DIM * 4; // float32
