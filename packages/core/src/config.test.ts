import { test, expect } from "bun:test";
import {
  resolveConfig,
  defaultConfig,
  getDeepValue,
  setDeepValue,
  deleteDeepValue,
  loreMindPath,
} from "@/config/index.ts";
import { LoreError } from "@/types/index.ts";

test("deep config helpers set, get, and delete", () => {
  const config: Record<string, unknown> = { a: { b: { c: 1 } } };
  expect(getDeepValue(config, "a.b.c")).toBe(1);

  setDeepValue(config, "a.b.d", 2);
  expect(getDeepValue(config, "a.b.d")).toBe(2);

  deleteDeepValue(config, "a.b.c");
  expect(getDeepValue(config, "a.b.c")).toBeUndefined();
});

test("resolveConfig applies layer precedence", () => {
  const loreMindConfig = {
    chunking: { target_tokens: 100 },
    thresholds: { dangling_days: 9 },
    rrf: { k: 10 },
  };

  const config = resolveConfig(
    { chunking: { target_tokens: 12, overlap: 0.05 } },
    loreMindConfig as Parameters<typeof resolveConfig>[1],
  );

  expect(config.chunking.target_tokens).toBe(12);
  expect(config.chunking.overlap).toBe(0.05);
  expect(config.thresholds.dangling_days).toBe(9);
  expect(config.rrf.k).toBe(10);
  expect(config).not.toBe(defaultConfig);
});

test("loreMindPath builds path under LORE_ROOT", () => {
  const path = loreMindPath("sample", "/tmp/root");
  expect(path).toBe("/tmp/root/minds/sample");
});

test("resolveConfig merges prompt guidance overrides without dropping defaults", () => {
  const config = resolveConfig(undefined, {
    ai: {
      generation: {
        prompts: {
          segment_topics: {
            guidance: "Prefer reusing existing concepts before creating new ones.",
          },
        },
      },
    },
  } as Parameters<typeof resolveConfig>[1]);

  expect(config.ai.generation.prompts.segment_topics.guidance).toBe(
    "Prefer reusing existing concepts before creating new ones.",
  );
  expect(config.ai.generation.prompts.name_cluster.guidance).toBe("");
  expect(config.ai.generation.prompts.generate_integration.guidance).toBe("");
});

test("resolveConfig merges reasoning overrides across layers", () => {
  const config = resolveConfig(
    {
      ai: {
        generation: {
          reasoning_overrides: {
            three_way_merge: "high",
          },
        },
      },
    } as Parameters<typeof resolveConfig>[0],
    {
      ai: {
        generation: {
          reasoning_overrides: {
            executive_summary: "none",
          },
        },
      },
    } as Parameters<typeof resolveConfig>[1],
  );

  expect(config.ai.generation.reasoning_overrides?.three_way_merge).toBe("high");
  expect(config.ai.generation.reasoning_overrides?.executive_summary).toBe("none");
});

test("resolveConfig fails closed on unknown prompt key", () => {
  try {
    resolveConfig(undefined, {
      ai: {
        generation: {
          prompts: {
            made_up_prompt: { guidance: "x" },
          },
        },
      },
    } as unknown as Parameters<typeof resolveConfig>[1]);
    throw new Error("expected CONFIG_INVALID");
  } catch (error) {
    expect(error).toBeInstanceOf(LoreError);
    expect((error as LoreError).code).toBe("CONFIG_INVALID");
  }
});

test("resolveConfig fails closed on non-string guidance", () => {
  try {
    resolveConfig(undefined, {
      ai: {
        generation: {
          prompts: {
            segment_topics: { guidance: 42 },
          },
        },
      },
    } as unknown as Parameters<typeof resolveConfig>[1]);
    throw new Error("expected CONFIG_INVALID");
  } catch (error) {
    expect(error).toBeInstanceOf(LoreError);
    expect((error as LoreError).code).toBe("CONFIG_INVALID");
  }
});
