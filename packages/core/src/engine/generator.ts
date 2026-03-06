import { generateText, type LanguageModel } from "ai";
import pRetry, { AbortError } from "p-retry";
import { LoreError } from "@/types/index.ts";
import type { LoreConfig, MergeStrategy } from "@/types/index.ts";
import { type GenerationPromptKey } from "@/config/prompts.ts";
import { createGenerationModel } from "./provider.ts";

type GenerationProvider = LoreConfig["ai"]["generation"]["provider"];
type ProviderOptionsValue = NonNullable<Parameters<typeof generateText>[0]["providerOptions"]>[string];
type ReasoningLevel = NonNullable<LoreConfig["ai"]["generation"]["reasoning"]>;
type ReasoningScope = keyof NonNullable<LoreConfig["ai"]["generation"]["reasoning_overrides"]>;
type GenerationPromptsConfig = LoreConfig["ai"]["generation"]["prompts"];
type ReasoningOverridesConfig = NonNullable<LoreConfig["ai"]["generation"]["reasoning_overrides"]>;

interface PromptBuildContext {
  conceptName?: string;
  targetParts?: number;
  existingConcepts?: string[];
  mergeStrategy?: MergeStrategy;
}

function withProjectGuidance(basePrompt: string, guidance: string): string {
  const normalized = guidance.trim();
  if (!normalized) return basePrompt;
  return `${basePrompt}

Project-specific guidance:
- Treat this as additional constraints.
- Never violate the hard-output contract above.
${normalized}`;
}

export function buildGenerationSystemPrompt(
  key: GenerationPromptKey,
  prompts: GenerationPromptsConfig,
  ctx?: PromptBuildContext,
): string {
  switch (key) {
    case "name_cluster": {
      const base = `You name knowledge clusters. Given content from related documents,
produce a short kebab-case name (2-4 words) that describes what the cluster is about.
Use hyphens between every word. Never concatenate words without hyphens.
Reply with ONLY the name, nothing else. Examples: auth-model, config-layer, query-pipeline`;
      return withProjectGuidance(base, prompts.name_cluster.guidance);
    }
    case "segment_topics": {
      const existingConcepts = ctx?.existingConcepts ?? [];
      const existingGuidance =
        existingConcepts.length > 0
          ? `Existing concepts: ${existingConcepts.join(", ")}

IMPORTANT: Prefer assigning entries to existing concepts. This includes:
- New findings about an existing concept
- Corrections, retractions, or updates to an existing concept
- Clarifications or refinements of an existing concept
Only create a new concept (kebab-case, 2-4 words) when the entry covers a genuinely new topic not covered by ANY existing concept.`
          : "Create concept names (kebab-case, 2-4 words) for each distinct topic group.";

      const base = `You segment journal entries into concept groups.
Each group should be a coherent topic that belongs together.
${existingGuidance}

Reply with ONLY a JSON array. Each element: {"concept": "kebab-name", "entries": [0, 1, ...]}
Entry indices are zero-based. Every entry must appear in exactly one group.
Aim for 2-6 groups. Do NOT put everything in one group unless the entries truly cover a single topic.`;
      return withProjectGuidance(base, prompts.segment_topics.guidance);
    }
    case "propose_split": {
      const targetParts = Math.max(2, ctx?.targetParts ?? 2);
      const base = `You split a concept into multiple new concepts.
Given one concept's content, propose ${targetParts} replacement concepts.

Rules:
- Return ONLY a JSON array.
- Each element must be: {"name":"kebab-case-name","content":"full concept content"}
- Names must be 2-4 words in kebab-case.
- Content must be self-contained and accurate.
- Do not overlap heavily across concepts.
- Keep the total information coverage comparable to the original concept.`;
      return withProjectGuidance(base, prompts.propose_split.guidance);
    }
    case "three_way_merge": {
      const conceptName = ctx?.conceptName ?? "<concept>";
      const base = `You perform a 3-way semantic merge for concept "${conceptName}".
You are given three versions:
- BASE: the content at the time the narrative was opened (may be null if concept didn't exist)
- HEAD: the current content on main (what others changed since BASE)
- NARRATIVE: the proposed new content from the closing narrative

Rules:
- Identify what HEAD changed vs BASE
- Identify what NARRATIVE changed vs BASE
- Merge non-overlapping changes from both
- For overlapping changes: combine intelligently, keeping the most specific/accurate information
- For contradictions: note the discrepancy inline, prefer NARRATIVE's version (it's newer)
- Output the final merged content only — no metadata, no markers, no explanation`;
      return withProjectGuidance(base, prompts.three_way_merge.guidance);
    }
    case "generate_integration": {
      const conceptName = ctx?.conceptName ?? "<concept>";
      const strategy = ctx?.mergeStrategy ?? "replace";

      let rules: string;
      if (strategy === "extend") {
        rules = `Rules:
- Write clean, informative prose — no frontmatter, no metadata
- Preserve ALL existing sections intact; do not remove any section
- Update only the specific paragraphs directly addressed by journal entries
- Add new sections at the end for wholly new topics introduced by journal entries
- Remove or rewrite a claim ONLY if a journal entry explicitly corrects or retracts it
- Be concise but complete`;
      } else if (strategy === "patch") {
        rules = `Rules:
- Write clean, informative prose — no frontmatter, no metadata
- Identify which paragraphs are semantically touched by journal entries; rewrite only those
- Reproduce all other paragraphs verbatim — do not rephrase, summarise, or reorganise them
- Add new paragraphs only for wholly new topics introduced by journal entries
- Remove or rewrite a paragraph ONLY if a journal entry explicitly corrects or retracts it
- Be concise but complete`;
      } else if (strategy === "correct") {
        rules = `Rules:
- Write clean, informative prose — no frontmatter, no metadata
- The journal entries are the authoritative source of truth
- Treat the existing state as POTENTIALLY WRONG — do NOT carry forward any claim from it unless a journal entry supports or is consistent with that claim
- If a journal entry contradicts the existing state, always use the journal entry's version
- If a section of the existing state is not addressed by any journal entry, OMIT it
- Do not invent information beyond what the journal entries establish
- Be concise but complete`;
      } else {
        // "replace" (default) — tightened: preserve sections not addressed by journal entries
        rules = `Rules:
- Write clean, informative prose — no frontmatter, no metadata
- If a journal entry CORRECTS or RETRACTS something in the existing state, REMOVE or REWRITE the wrong claim — do not preserve it
- If a journal entry adds new information, integrate it
- Dead ends: note briefly as warnings only if they help future readers avoid the same mistake
- The output replaces the existing state entirely — it must be self-contained and accurate
- If the existing state covers topics NOT addressed by any journal entry, preserve those sections as-is
- Be concise but complete`;
      }

      const base = `You are integrating journal entries into a knowledge base state chunk.
Given journal entries from a narrative and the existing state for concept "${conceptName}",
produce an updated state chunk that reflects the current truth.

${rules}`;
      return withProjectGuidance(base, prompts.generate_integration.guidance);
    }
    default:
      return "";
  }
}

export class Generator {
  private model: LanguageModel;
  private provider: GenerationProvider;
  private reasoning: ReasoningLevel;
  private reasoningOverrides?: Partial<ReasoningOverridesConfig>;
  private prompts: GenerationPromptsConfig;

  private constructor(
    model: LanguageModel,
    provider: GenerationProvider,
    reasoning: ReasoningLevel,
    reasoningOverrides: Partial<ReasoningOverridesConfig> | undefined,
    prompts: GenerationPromptsConfig,
  ) {
    this.model = model;
    this.provider = provider;
    this.reasoning = reasoning;
    this.reasoningOverrides = reasoningOverrides;
    this.prompts = prompts;
  }

  static async create(config: LoreConfig, appName?: string): Promise<Generator> {
    const model = await createGenerationModel(config, appName);
    return new Generator(
      model,
      config.ai.generation.provider,
      config.ai.generation.reasoning ?? "none",
      config.ai.generation.reasoning_overrides,
      config.ai.generation.prompts,
    );
  }

  private resolveReasoningLevel(scope?: ReasoningScope, override?: ReasoningLevel): ReasoningLevel {
    if (override) return override;
    if (scope && this.reasoningOverrides?.[scope]) return this.reasoningOverrides[scope]!;
    return this.reasoning;
  }

  private moonshotThinkingOptions(reasoning: ReasoningLevel): ProviderOptionsValue {
    if (reasoning === "none") {
      return {
        thinking: { type: "disabled" },
        reasoningHistory: "disabled",
      };
    }
    const budgetTokens = reasoning === "low" ? 1024 : reasoning === "high" ? 4096 : 2048;
    return {
      thinking: { type: "enabled", budgetTokens },
      reasoningHistory: "disabled",
    };
  }

  private reasoningOptions(reasoning: ReasoningLevel): {
    systemSuffix: string;
    providerOptions?: Record<string, ProviderOptionsValue>;
  } {
    const noThinkSuffix = reasoning === "none" ? "\n/no_think" : "";
    switch (this.provider) {
      case "groq":
        return {
          systemSuffix: "",
          providerOptions: {
            groq: {
              reasoningEffort: reasoning,
              ...(reasoning === "none" && { reasoningFormat: "hidden" }),
            },
          },
        };
      case "openai":
        return {
          systemSuffix: "",
          providerOptions: {
            openai: { reasoningEffort: reasoning === "none" ? "low" : reasoning },
          },
        };
      case "openrouter":
        return {
          systemSuffix: noThinkSuffix,
        };
      case "moonshotai":
        return {
          systemSuffix: noThinkSuffix,
          providerOptions: {
            moonshotai: this.moonshotThinkingOptions(reasoning),
          },
        };
      case "alibaba":
        return {
          systemSuffix: noThinkSuffix,
        };
      case "ollama":
        return {
          systemSuffix: noThinkSuffix,
        };
      default:
        return {
          systemSuffix: noThinkSuffix,
        };
    }
  }

  async generate(
    system: string,
    user: string,
    opts?: { timeoutMs?: number; reasoning?: ReasoningLevel; scope?: ReasoningScope },
  ): Promise<string> {
    const result = await this.generateWithMeta(system, user, opts);
    return result.text;
  }

  async generateWithMeta(
    system: string,
    user: string,
    opts?: { timeoutMs?: number; reasoning?: ReasoningLevel; scope?: ReasoningScope },
  ): Promise<{ text: string; usage: { promptTokens: number; completionTokens: number; totalTokens: number }; modelId: string }> {
    const reasoning = this.resolveReasoningLevel(opts?.scope, opts?.reasoning);
    const reasoningOpts = this.reasoningOptions(reasoning);
    const timeoutMs = opts?.timeoutMs;
    try {
      const result = await pRetry(
        async () => {
          try {
            return await generateText({
              model: this.model,
              system: system + reasoningOpts.systemSuffix,
              prompt: user,
              ...(reasoningOpts.providerOptions && { providerOptions: reasoningOpts.providerOptions }),
              ...(timeoutMs && timeoutMs > 0 ? { timeout: timeoutMs } : {}),
            });
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            // Don't retry on auth, quota, or bad request errors
            if (/401|403|invalid.*(api.key|auth)|quota|bad.request|400/i.test(msg)) {
              throw new AbortError(msg);
            }
            throw error;
          }
        },
        { retries: 2, minTimeout: 5000, factor: 2 },
      );
      // Strip thinking tags in case model ignores reasoning config
      const text = result.text.replace(/<think>[\s\S]*?<\/think>\s*/g, "");
      const inputTokens = result.usage?.inputTokens ?? 0;
      const outputTokens = result.usage?.outputTokens ?? 0;
      return {
        text,
        usage: {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        },
        modelId: result.response?.modelId ?? "",
      };
    } catch (error) {
      throw new LoreError(
        "AI_UNAVAILABLE",
        `Generation failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async nameCluster(contents: string[]): Promise<string> {
    const system = buildGenerationSystemPrompt("name_cluster", this.prompts);

    const joined = contents.map((c, i) => `--- Document ${i + 1} ---\n${c}`).join("\n\n");
    const result = await this.generate(system, joined, { scope: "name_cluster" });
    return result
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^a-z0-9-]/g, "");
  }

  async segmentTopics(
    journalEntries: string[],
    existingConcepts: string[],
    entryHints?: string[][],
  ): Promise<Array<{ concept: string; entries: number[] }>> {
    const system = buildGenerationSystemPrompt("segment_topics", this.prompts, {
      existingConcepts,
    });

    const numbered = journalEntries
      .map((e, i) => {
        const hints = entryHints?.[i];
        const prefix = hints && hints.length > 0 ? `(hints: ${hints.join(", ")}) ` : "";
        return `[${i}] ${prefix}${e.slice(0, 300)}`;
      })
      .join("\n\n");

    const result = await this.generate(system, numbered, { scope: "segment_topics" });

    try {
      // Extract JSON from response (may have markdown fences)
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return this.fallbackSegmentation(journalEntries);
      }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed) || parsed.length === 0)
        return this.fallbackSegmentation(journalEntries);

      // Validate structure
      const seen = new Set<number>();
      const groups: Array<{ concept: string; entries: number[] }> = [];
      for (const item of parsed) {
        if (typeof item.concept !== "string" || !Array.isArray(item.entries)) continue;
        const name = item.concept
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
        if (!name) continue;
        const indices = item.entries.filter(
          (i: unknown): i is number =>
            typeof i === "number" && i >= 0 && i < journalEntries.length && !seen.has(i as number),
        );
        for (const i of indices) seen.add(i);
        if (indices.length > 0) groups.push({ concept: name, entries: indices });
      }

      // Assign any orphaned entries to the largest group
      if (seen.size < journalEntries.length && groups.length > 0) {
        const largest = groups.reduce((a, b) => (a.entries.length >= b.entries.length ? a : b));
        for (let i = 0; i < journalEntries.length; i++) {
          if (!seen.has(i)) largest.entries.push(i);
        }
      }

      return groups.length > 0 ? groups : this.fallbackSegmentation(journalEntries);
    } catch {
      return this.fallbackSegmentation(journalEntries);
    }
  }

  private fallbackSegmentation(
    journalEntries: string[],
  ): Array<{ concept: string; entries: number[] }> {
    // Each entry becomes its own group — nameCluster will name them later
    return journalEntries.map((_, i) => ({
      concept: `topic-${i + 1}`,
      entries: [i],
    }));
  }

  async proposeSplit(
    conceptName: string,
    content: string,
    parts: number = 2,
  ): Promise<Array<{ name: string; content: string }>> {
    const targetParts = Math.max(2, parts);
    const system = buildGenerationSystemPrompt("propose_split", this.prompts, {
      conceptName,
      targetParts,
    });

    const result = await this.generate(system, `Concept: ${conceptName}\n\nContent:\n${content}`, {
      scope: "propose_split",
    });

    try {
      const jsonMatch = result.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return this.fallbackSplit(conceptName, content, targetParts);
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed) || parsed.length < 2) {
        return this.fallbackSplit(conceptName, content, targetParts);
      }

      const proposals: Array<{ name: string; content: string }> = [];
      for (const item of parsed) {
        if (!item || typeof item !== "object") continue;
        if (typeof item.name !== "string" || typeof item.content !== "string") continue;
        const name = item.name
          .trim()
          .toLowerCase()
          .replace(/\s+/g, "-")
          .replace(/[^a-z0-9-]/g, "");
        const splitContent = item.content.trim();
        if (!name || !splitContent) continue;
        proposals.push({ name, content: splitContent });
      }

      return proposals.length >= 2
        ? proposals
        : this.fallbackSplit(conceptName, content, targetParts);
    } catch {
      return this.fallbackSplit(conceptName, content, targetParts);
    }
  }

  private fallbackSplit(
    conceptName: string,
    content: string,
    parts: number,
  ): Array<{ name: string; content: string }> {
    const paragraphs = content.split(/\n\n+/).filter((p) => p.trim().length > 0);
    if (paragraphs.length === 0) {
      return Array.from({ length: parts }, (_, i) => ({
        name: `${conceptName}-part-${i + 1}`.replace(/[^a-z0-9-]/g, ""),
        content,
      }));
    }

    const groups: string[][] = Array.from({ length: parts }, () => []);
    for (let i = 0; i < paragraphs.length; i++) {
      groups[i % parts]!.push(paragraphs[i]!);
    }

    return groups
      .map((g, i) => ({
        name: `${conceptName}-part-${i + 1}`.replace(/[^a-z0-9-]/g, ""),
        content: g.join("\n\n").trim(),
      }))
      .filter((g) => g.content.length > 0);
  }

  async threeWayMerge(
    conceptName: string,
    baseContent: string | null,
    headContent: string,
    deltaContent: string,
  ): Promise<string> {
    const system = buildGenerationSystemPrompt("three_way_merge", this.prompts, { conceptName });

    const parts: string[] = [];
    if (baseContent != null) {
      parts.push(`BASE:\n${baseContent}`);
    } else {
      parts.push("BASE: (concept did not exist)");
    }
    parts.push(`HEAD:\n${headContent}`);
    parts.push(`DELTA:\n${deltaContent}`);

    return this.generate(system, parts.join("\n\n---\n\n"), { scope: "three_way_merge" });
  }

  async generateDriftQuestions(
    conceptName: string,
    symbolName: string,
    oldBody: string,
    newBody: string,
  ): Promise<string[]> {
    const system = `You are a codebase knowledge assistant helping an agent understand what changed in a symbol.
Given the old and new body of a symbol bound to a concept, produce 3-5 targeted investigation questions
the agent should answer by journaling. Questions should be specific to the actual diff — not generic.
Output ONLY a JSON array of strings. No prose, no markdown, no explanation.
Example: ["What invariant did X enforce that no longer holds?", "Why was Y removed?"]`;

    const prompt =
      `Concept: ${conceptName}\nSymbol: ${symbolName}\n\nOLD:\n${oldBody.slice(0, 1500)}\n\nNEW:\n${newBody.slice(0, 1500)}`;

    try {
      const raw = await this.generate(system, prompt, { scope: "generate_integration" });
      const match = raw.match(/\[[\s\S]*\]/);
      if (!match) return [];
      return JSON.parse(match[0]) as string[];
    } catch {
      return [];
    }
  }

  async generateIntegration(
    journalEntries: string[],
    existingState: string[],
    conceptName: string,
    mergeStrategy?: MergeStrategy,
  ): Promise<string> {
    const system = buildGenerationSystemPrompt("generate_integration", this.prompts, {
      conceptName,
      mergeStrategy,
    });

    const existing =
      existingState.length > 0 ? `Current state:\n${existingState.join("\n\n---\n\n")}\n\n` : "";
    const journal = `Journal entries:\n${journalEntries.join("\n\n---\n\n")}`;

    return this.generate(system, existing + journal, { scope: "generate_integration" });
  }
}
