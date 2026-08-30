import { expect, test, afterEach } from "bun:test";
import { createGenerationModel, createEmbeddingModel } from "./provider.ts";
import { resolveConfig } from "@/config/index.ts";
import type { LoreConfig } from "@/types/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function captureHeaders(): Record<string, string> {
  const seen: Record<string, string> = {};
  globalThis.fetch = (async (_url: unknown, init: RequestInit | undefined) => {
    new Headers(init?.headers).forEach((value, key) => {
      seen[key] = value;
    });
    return new Response(
      JSON.stringify({
        choices: [{ message: { content: "x" }, finish_reason: "stop" }],
        data: [{ embedding: [0, 1] }],
        usage: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return seen;
}

function openrouterConfig(role: "generation" | "embedding"): LoreConfig {
  return resolveConfig({
    ai: { [role]: { provider: "openrouter", model: "z-ai/glm-5.3-flash", api_key: "sk-test" } },
  } as unknown as Partial<LoreConfig>);
}

test("generation calls carry the referer that creates the app entry", async () => {
  const seen = captureHeaders();
  const model = (await createGenerationModel(openrouterConfig("generation"))) as never;
  try {
    await (model as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    });
  } catch {
    // The response shape is not what matters here; the request headers are.
  }
  // Without HTTP-Referer, OpenRouter files the usage under "Unknown".
  expect(seen["http-referer"]).toBe("https://github.com/gezibash/lore");
  expect(seen["x-openrouter-title"]).toBe("Lore");
  expect(seen["x-title"]).toBe("Lore");
});

test("embedding calls carry the same attribution", async () => {
  const seen = captureHeaders();
  const model = (await createEmbeddingModel(openrouterConfig("embedding"))) as never;
  try {
    await (model as { doEmbed: (o: unknown) => Promise<unknown> }).doEmbed({ values: ["hi"] });
  } catch {
    // As above.
  }
  expect(seen["http-referer"]).toBe("https://github.com/gezibash/lore");
  expect(seen["x-openrouter-title"]).toBe("Lore");
});

test("the title is constant, so one lore cannot rename the app page", async () => {
  const first = captureHeaders();
  const a = (await createGenerationModel(openrouterConfig("generation"))) as never;
  try {
    await (a as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "x" }] }],
    });
  } catch {
    // As above.
  }

  const second = captureHeaders();
  const b = (await createGenerationModel(openrouterConfig("generation"))) as never;
  try {
    await (b as { doGenerate: (o: unknown) => Promise<unknown> }).doGenerate({
      prompt: [{ role: "user", content: [{ type: "text", text: "y" }] }],
    });
  } catch {
    // As above.
  }

  expect(second["x-openrouter-title"]).toBe(first["x-openrouter-title"]);
});
