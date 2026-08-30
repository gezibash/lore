import { expect, test, afterEach } from "bun:test";
import { listProviderModels } from "./provider-models.ts";
import { LoreError } from "@/types/index.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(payload: unknown, capture?: { url?: string; auth?: string | null }) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (capture) {
      capture.url = String(url);
      capture.auth = new Headers(init?.headers).get("authorization");
    }
    return new Response(JSON.stringify(payload), { status: 200 });
  }) as typeof fetch;
}

function openRouterPayload(ids: string[]) {
  return {
    data: ids.map((id) => ({
      id,
      context_length: 1311000,
      pricing: { prompt: "0.000000075", completion: "0.00000025" },
      architecture: { modality: "text->text" },
    })),
  };
}

test("normalizes OpenRouter pricing to USD per million tokens", async () => {
  stubFetch(openRouterPayload(["z-ai/glm-5.3-flash"]));
  const page = await listProviderModels("openrouter");
  expect(page.models[0]).toMatchObject({
    id: "z-ai/glm-5.3-flash",
    context_length: 1311000,
    prompt_usd_per_mtok: 0.075,
    completion_usd_per_mtok: 0.25,
    modality: "text->text",
  });
});

test("defaults to the OpenRouter base URL and sends the key when present", async () => {
  const capture: { url?: string; auth?: string | null } = {};
  stubFetch(openRouterPayload(["a/b"]), capture);
  await listProviderModels("openrouter", { api_key: "sk-or-test" });
  expect(capture.url).toBe("https://openrouter.ai/api/v1/models");
  expect(capture.auth).toBe("Bearer sk-or-test");
});

test("a trailing slash on the base URL does not double up", async () => {
  const capture: { url?: string } = {};
  stubFetch(openRouterPayload(["a/b"]), capture);
  await listProviderModels("openai-compatible", { base_url: "https://host/v1///" });
  expect(capture.url).toBe("https://host/v1/models");
});

test("search filters, and paging reports the unpaged total", async () => {
  stubFetch(openRouterPayload(["z-ai/glm-5.3", "z-ai/glm-5.3-flash", "openai/gpt-4o"]));
  const page = await listProviderModels("openrouter", { search: "GLM", limit: 1, page: 2 });
  expect(page.total).toBe(2);
  expect(page.pages).toBe(2);
  expect(page.models.map((m) => m.id)).toEqual(["z-ai/glm-5.3-flash"]);
});

test("a page past the end clamps to the last page", async () => {
  stubFetch(openRouterPayload(["a/one", "a/two"]));
  const page = await listProviderModels("openrouter", { limit: 1, page: 99 });
  expect(page.page).toBe(2);
  expect(page.models.map((m) => m.id)).toEqual(["a/two"]);
});

test("reads the Ollama tag list, which has no pricing", async () => {
  const capture: { url?: string } = {};
  stubFetch({ models: [{ name: "qwen3:8b", details: { parameter_size: "8B" } }] }, capture);
  const page = await listProviderModels("ollama");
  expect(capture.url).toBe("http://localhost:11434/api/tags");
  expect(page.models[0]).toMatchObject({ id: "qwen3:8b", name: "8B" });
  expect(page.models[0]?.prompt_usd_per_mtok).toBeUndefined();
});

test("a provider with no catalog names the ones that have one", async () => {
  await expect(listProviderModels("voyage")).rejects.toThrow(
    /publishes no model catalog.*openrouter/s,
  );
});

test("openai-compatible without a base URL says how to set one", async () => {
  await expect(listProviderModels("openai-compatible")).rejects.toThrow(
    /lore sys provider set openai-compatible --base-url/,
  );
});

test("an error status surfaces the body, not a bare status code", async () => {
  globalThis.fetch = (async () =>
    new Response("invalid api key", { status: 401 })) as unknown as typeof fetch;
  const error = (await listProviderModels("openrouter").catch((e) => e)) as LoreError;
  expect(error).toBeInstanceOf(LoreError);
  expect(error.code).toBe("AI_UNAVAILABLE");
  expect(error.message).toContain("invalid api key");
});
