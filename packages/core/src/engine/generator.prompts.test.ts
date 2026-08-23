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

test("every integration strategy says where a new topic goes", () => {
  // The default 'replace' strategy shipped without a placement rule while
  // 'extend' and 'patch' had one. Integrating a finding about citation
  // injection into a concept then spliced it into the middle of a paragraph
  // about MCP cleanup, and lore's own phase-transition check flagged the
  // result as a 63% restructure.
  for (const mergeStrategy of ["extend", "patch", "correct", "replace"] as const) {
    const system = buildGenerationSystemPrompt(
      "generate_integration",
      defaultConfig.ai.generation.prompts,
      { conceptName: "citation-provenance", mergeStrategy },
    );
    expect(system).toMatch(/(new|own) (section|paragraph)/i);
    expect(system).toMatch(
      /never append an unrelated|new sections? (at the end )?for wholly new|new paragraphs? only for wholly new/i,
    );
  }
});
