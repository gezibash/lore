import type { LanguageModelV3, LanguageModelV3CallOptions } from "@ai-sdk/provider";
import { codexAppServerFor } from "./codex-appserver.ts";

/**
 * Generation through the locally installed Codex CLI, billed to the user's Codex
 * subscription instead of a metered API key.
 *
 * `codex exec` is an agent, not a completion endpoint: every call boots Codex's
 * own system prompt and tool definitions (~13k input tokens that lore never uses).
 * `--ignore-user-config` drops the user's skills/MCP servers on top of that, which
 * roughly halves both latency and overhead. Fine for interactive asks; do not point
 * bulk/parallel workloads at it — those belong on a metered provider.
 */

function flattenPrompt(prompt: LanguageModelV3CallOptions["prompt"]): string {
  const blocks: string[] = [];
  for (const message of prompt) {
    if (message.role === "system") {
      blocks.push(message.content);
      continue;
    }
    if (message.role === "user" || message.role === "assistant") {
      const text = message.content
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((t) => t.length > 0)
        .join("\n");
      if (text) blocks.push(text);
    }
  }
  return blocks.join("\n\n");
}

export interface CodexModelOptions {
  /** Path to the codex binary. Defaults to `codex` on PATH. */
  binPath?: string;
  /** Codex reasoning effort. Summaries want "low"; leave unset to use Codex's own default. */
  reasoningEffort?: string;
  /** Service tier, e.g. "fast". Transmitted per request; note the backend may
   *  silently serve "default" for headless exec traffic (openai/codex#32191). */
  serviceTier?: string;
}

export function createCodexLanguageModel(
  modelId: string,
  opts?: CodexModelOptions,
): LanguageModelV3 {
  const bin = opts?.binPath ?? "codex";

  return {
    specificationVersion: "v3",
    provider: "codex",
    modelId,
    supportedUrls: {},

    async doGenerate(options) {
      // A concurrent codex process can leave the shared models cache in a shape
      // this binary rejects; the failure is transient and the next call re-reads
      // it. Retry once so parallel asks don't drop requests.
      try {
        return await runCodex(options);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/models cache|turn|transport/i.test(message)) throw error;
        codexAppServerFor(bin).kill();
        await new Promise((resolve) => setTimeout(resolve, 500));
        return await runCodex(options);
      }
    },

    async doStream() {
      // lore never streams generations; fail loudly rather than silently degrading.
      throw new Error("codex provider does not support streaming");
    },
  };

  async function runCodex(options: LanguageModelV3CallOptions) {
    const promptText = flattenPrompt(options.prompt);
    const server = codexAppServerFor(bin);
    const { text, inputTokens, outputTokens } = await server.complete(promptText, {
      model: modelId,
      reasoningEffort: opts?.reasoningEffort,
      serviceTier: opts?.serviceTier,
      abortSignal: options.abortSignal,
    });

    return {
      content: [{ type: "text" as const, text }],
      finishReason: { unified: "stop" as const, raw: undefined },
      warnings: [],
      usage: {
        inputTokens: {
          total: inputTokens,
          noCache: inputTokens,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: { total: outputTokens, text: outputTokens, reasoning: undefined },
      },
    };
  }
}
