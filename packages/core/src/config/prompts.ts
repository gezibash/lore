import { LoreError } from "@/types/index.ts";

export const GENERATION_PROMPT_KEYS = [
  "name_cluster",
  "segment_topics",
  "propose_split",
  "three_way_merge",
  "generate_integration",
] as const;

export type GenerationPromptKey = (typeof GENERATION_PROMPT_KEYS)[number];

export interface GenerationPromptConfig {
  guidance: string;
}

export type GenerationPromptsConfig = Record<GenerationPromptKey, GenerationPromptConfig>;

const MAX_GUIDANCE_CHARS = 4000;

export const defaultGenerationPrompts: GenerationPromptsConfig = {
  name_cluster: { guidance: "" },
  segment_topics: { guidance: "" },
  propose_split: { guidance: "" },
  three_way_merge: { guidance: "" },
  generate_integration: { guidance: "" },
};

const PROMPT_KEY_ALIASES: Record<string, GenerationPromptKey> = {
  "name-cluster": "name_cluster",
  namecluster: "name_cluster",
  segmenttopics: "segment_topics",
  "segment-topics": "segment_topics",
  proposesplit: "propose_split",
  "propose-split": "propose_split",
  threewaymerge: "three_way_merge",
  "three-way-merge": "three_way_merge",
  generateintegration: "generate_integration",
  "generate-integration": "generate_integration",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function clonePrompts(prompts: GenerationPromptsConfig): GenerationPromptsConfig {
  return {
    name_cluster: { guidance: prompts.name_cluster.guidance },
    segment_topics: { guidance: prompts.segment_topics.guidance },
    propose_split: { guidance: prompts.propose_split.guidance },
    three_way_merge: { guidance: prompts.three_way_merge.guidance },
    generate_integration: { guidance: prompts.generate_integration.guidance },
  };
}

function validateGuidance(key: GenerationPromptKey, guidance: unknown): string {
  if (guidance === undefined) return "";
  if (typeof guidance !== "string") {
    throw new LoreError(
      "CONFIG_INVALID",
      `Invalid ai.generation.prompts.${key}.guidance: expected string`,
    );
  }
  const trimmed = guidance.trim();
  if (trimmed.length > MAX_GUIDANCE_CHARS) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Invalid ai.generation.prompts.${key}.guidance: max ${MAX_GUIDANCE_CHARS} chars`,
    );
  }
  return trimmed;
}

export function mergeGenerationPrompts(
  base: GenerationPromptsConfig,
  overrides: unknown,
): GenerationPromptsConfig {
  const merged = clonePrompts(base);
  if (overrides === undefined || overrides === null) return merged;
  if (!isRecord(overrides)) {
    throw new LoreError("CONFIG_INVALID", "Invalid ai.generation.prompts: expected object");
  }

  const unknownPromptKeys = Object.keys(overrides).filter(
    (k) => !GENERATION_PROMPT_KEYS.includes(k as GenerationPromptKey),
  );
  if (unknownPromptKeys.length > 0) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Unknown ai.generation.prompts key(s): ${unknownPromptKeys.join(", ")}`,
    );
  }

  for (const key of GENERATION_PROMPT_KEYS) {
    const rawPromptConfig = overrides[key];
    if (rawPromptConfig === undefined) continue;
    if (!isRecord(rawPromptConfig)) {
      throw new LoreError(
        "CONFIG_INVALID",
        `Invalid ai.generation.prompts.${key}: expected object`,
      );
    }

    const unknownFields = Object.keys(rawPromptConfig).filter((f) => f !== "guidance");
    if (unknownFields.length > 0) {
      throw new LoreError(
        "CONFIG_INVALID",
        `Unknown ai.generation.prompts.${key} field(s): ${unknownFields.join(", ")}`,
      );
    }

    const guidance =
      rawPromptConfig.guidance === undefined
        ? merged[key].guidance
        : validateGuidance(key, rawPromptConfig.guidance);
    merged[key] = { guidance };
  }

  return merged;
}

export function normalizePromptKey(value: string): GenerationPromptKey | null {
  const lowered = value.trim().toLowerCase();
  if (GENERATION_PROMPT_KEYS.includes(lowered as GenerationPromptKey)) {
    return lowered as GenerationPromptKey;
  }
  return PROMPT_KEY_ALIASES[lowered] ?? null;
}
