import { expect, test, afterEach } from "bun:test";
import { createGenerationModel, createEmbeddingModel } from "./provider.ts";
import { resolveConfig } from "@/config/index.ts";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
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

/**
 * resolveConfig reads ~/.lore/config.json as its second layer, so a test that
 * omits lore_root inherits the developer's real provider and base URL and can
 * pass for the wrong reason. An empty root keeps it to defaults.
 */
function hermetic(overrides: Record<string, unknown>): LoreConfig {
  return resolveConfig({
    lore_root: mkdtempSync(`${tmpdir()}/lore-cfg-`),
    ...overrides,
  } as unknown as Partial<LoreConfig>);
}

function openrouterConfig(role: "generation" | "embedding"): LoreConfig {
  return hermetic({
    ai: { [role]: { provider: "openrouter", model: "z-ai/glm-5.3-flash", api_key: "sk-test" } },
  });
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

test("openai-compatible without a base URL says which key to set", async () => {
  const config = hermetic({
    ai: { generation: { provider: "openai-compatible", model: "m", api_key: "k" } },
  });
  // Without the check this resolves and the first request goes to
  // "undefined/chat/completions".
  await expect(createGenerationModel(config)).rejects.toThrow(
    /lore sys config set ai\.generation\.base_url/,
  );
});

test("the embedding role names its own config key, not generation's", async () => {
  const config = hermetic({
    ai: { embedding: { provider: "openai-compatible", model: "m", api_key: "k" } },
  });
  await expect(createEmbeddingModel(config)).rejects.toThrow(
    /lore sys config set ai\.embedding\.base_url/,
  );
});

test("a base URL that is set passes the check", async () => {
  const config = hermetic({
    ai: {
      generation: {
        provider: "openai-compatible",
        model: "m",
        api_key: "k",
        base_url: "https://host/v1",
      },
    },
  });
  await expect(createGenerationModel(config)).resolves.toBeDefined();
});
