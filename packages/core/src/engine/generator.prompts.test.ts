import { test, expect } from "bun:test";
import { defaultConfig } from "@/config/index.ts";
import { buildGenerationSystemPrompt } from "./generator.ts";

test("buildGenerationSystemPrompt uses built-in contract when guidance is empty", () => {
  const system = buildGenerationSystemPrompt("name_cluster", defaultConfig.ai.generation.prompts);

  expect(system).toContain("You name knowledge clusters.");
  expect(system).not.toContain("Project-specific guidance:");
});

test("buildGenerationSystemPrompt appends project guidance for configured prompts", () => {
  const prompts = {
    ...defaultConfig.ai.generation.prompts,
    segment_topics: {
      guidance: "Bias toward fewer, broader concepts unless entries are clearly unrelated.",
    },
  };

  const system = buildGenerationSystemPrompt("segment_topics", prompts, {
    existingConcepts: ["auth-model", "session-cache"],
  });

  expect(system).toContain("Existing concepts: auth-model, session-cache");
  expect(system).toContain("Project-specific guidance:");
  expect(system).toContain(
    "Bias toward fewer, broader concepts unless entries are clearly unrelated.",
  );
});
