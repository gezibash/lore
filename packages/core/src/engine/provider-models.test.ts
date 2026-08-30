import { expect, test, afterEach } from "bun:test";
import { getProviderUsage, listAllProviderModels, listProviderModels } from "./provider-models.ts";
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

function vercelPayload(
  rows: Array<{ id: string; type?: string; input?: string; output?: string; ctx?: number }>,
) {
  return {
    data: rows.map((row) => ({
      id: row.id,
      type: row.type ?? "language",
      context_window: row.ctx ?? 128000,
      pricing: { input: row.input ?? "0.000001", output: row.output ?? "0.000002" },
    })),
  };
}

test("reads Vercel's input/output pricing keys, not just prompt/completion", async () => {
  stubFetch(vercelPayload([{ id: "zai/glm-5.3-flash", input: "0.00000015" }]));
  const page = await listProviderModels("gateway");
  expect(page.models[0]).toMatchObject({
    id: "zai/glm-5.3-flash",
    prompt_usd_per_mtok: 0.15,
    completion_usd_per_mtok: 2,
    context_length: 128000,
    kind: "generation",
  });
});

test("gateway defaults to the Vercel AI Gateway base URL", async () => {
  const capture: { url?: string } = {};
  stubFetch(vercelPayload([{ id: "a/b" }]), capture);
  await listProviderModels("gateway");
  expect(capture.url).toBe("https://ai-gateway.vercel.sh/v1/models");
});

test("kinds lore cannot use are hidden unless asked for", async () => {
  const payload = vercelPayload([
    { id: "a/lang", type: "language" },
    { id: "b/embed", type: "embedding" },
    { id: "c/video", type: "video" },
  ]);
  stubFetch(payload);
  const usable = await listProviderModels("gateway");
  expect(usable.models.map((m) => m.id)).toEqual(["a/lang", "b/embed"]);

  stubFetch(payload);
  const everything = await listProviderModels("gateway", {
    kinds: ["generation", "embedding", "other"],
  });
  expect(everything.total).toBe(3);

  stubFetch(payload);
  const embeddingOnly = await listProviderModels("gateway", { kinds: ["embedding"] });
  expect(embeddingOnly.models.map((m) => m.id)).toEqual(["b/embed"]);
});

test("price sort is cheapest first and puts unpriced models last", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: [
          { id: "b/mid", pricing: { input: "0.000002" } },
          { id: "c/free" },
          { id: "a/cheap", pricing: { input: "0.000001" } },
        ],
      }),
      { status: 200 },
    )) as unknown as typeof fetch;
  const page = await listProviderModels("gateway", { sort: "price" });
  expect(page.models.map((m) => m.id)).toEqual(["a/cheap", "b/mid", "c/free"]);
});

test("context sort is roomiest first", async () => {
  stubFetch(
    vercelPayload([
      { id: "a/small", ctx: 8000 },
      { id: "b/big", ctx: 1000000 },
    ]),
  );
  const page = await listProviderModels("gateway", { sort: "context" });
  expect(page.models.map((m) => m.id)).toEqual(["b/big", "a/small"]);
});

test("one dead provider does not lose the others' models", async () => {
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("openrouter")) throw new Error("network down");
    return new Response(JSON.stringify(vercelPayload([{ id: "zai/glm-5.3" }])), { status: 200 });
  }) as unknown as typeof fetch;

  const page = await listAllProviderModels([{ provider: "openrouter" }, { provider: "gateway" }]);
  expect(page.provider).toBe("all");
  expect(page.models.map((m) => m.id)).toEqual(["zai/glm-5.3"]);
  expect(page.models[0]?.provider).toBe("gateway");
  expect(page.failures).toEqual([
    { provider: "openrouter", reason: expect.stringContaining("network down") },
  ]);
});

test("cross-provider price sort compares across providers, not within each", async () => {
  globalThis.fetch = (async (url: string) => {
    const cheap = String(url).includes("openrouter");
    return new Response(
      JSON.stringify(
        vercelPayload([
          { id: cheap ? "or/cheap" : "gw/pricey", input: cheap ? "0.0000001" : "0.000009" },
        ]),
      ),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const page = await listAllProviderModels([{ provider: "gateway" }, { provider: "openrouter" }], {
    sort: "price",
  });
  expect(page.models.map((m) => m.id)).toEqual(["or/cheap", "gw/pricey"]);
});

test("OpenRouter balance is credits bought minus credits used", async () => {
  globalThis.fetch = (async (url: string) => {
    const body = String(url).endsWith("/credits")
      ? { data: { total_credits: 75, total_usage: 52.68 } }
      : {
          data: {
            usage: 19.94,
            usage_daily: 0,
            usage_monthly: 16.06,
            limit: null,
            is_free_tier: false,
          },
        };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof fetch;

  const usage = await getProviderUsage("openrouter", { api_key: "sk-or-test" });
  expect(usage.balance_usd).toBeCloseTo(22.32, 2);
  expect(usage.used_usd).toBeCloseTo(52.68, 2);
  expect(usage.key_used_usd).toBeCloseTo(19.94, 2);
  expect(usage.key_used_month_usd).toBeCloseTo(16.06, 2);
  expect(usage.limit_usd).toBeUndefined();
  expect(usage.free_tier).toBe(false);
});

test("a dead /key endpoint still yields the account balance", async () => {
  globalThis.fetch = (async (url: string) => {
    if (String(url).endsWith("/key")) throw new Error("nope");
    return new Response(JSON.stringify({ data: { total_credits: 10, total_usage: 4 } }), {
      status: 200,
    });
  }) as unknown as typeof fetch;

  const usage = await getProviderUsage("openrouter", { api_key: "sk-or-test" });
  expect(usage.balance_usd).toBe(6);
  expect(usage.key_used_usd).toBeUndefined();
});

test("Vercel reports the balance directly, as strings", async () => {
  const capture: { url?: string } = {};
  globalThis.fetch = (async (url: string) => {
    capture.url = String(url);
    return new Response(JSON.stringify({ balance: "95.50", total_used: "4.50" }), { status: 200 });
  }) as unknown as typeof fetch;

  const usage = await getProviderUsage("gateway", { api_key: "vck-test" });
  expect(capture.url).toBe("https://ai-gateway.vercel.sh/v1/credits");
  expect(usage.balance_usd).toBe(95.5);
  expect(usage.used_usd).toBe(4.5);
});

test("usage without a key says how to set one", async () => {
  await expect(getProviderUsage("openrouter")).rejects.toThrow(/lore sys provider set openrouter/);
});

test("a provider with no balance names the ones that have one", async () => {
  await expect(getProviderUsage("ollama", { api_key: "x" })).rejects.toThrow(
    /reports no balance.*openrouter, gateway/s,
  );
});
