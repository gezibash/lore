/**
 * List the models a provider offers.
 *
 * Picking a model means knowing the exact id string, the context window, and
 * the price. Only the provider knows those, and each one publishes them at its
 * own endpoint in its own shape. This normalizes the five that expose a catalog
 * over HTTP; the rest have no such endpoint and say so.
 */
import { LoreError, type SharedProvider } from "@/types/index.ts";

export interface ProviderModel {
  id: string;
  name?: string;
  /** Maximum context in tokens. */
  context_length?: number;
  /** USD per million input tokens. */
  prompt_usd_per_mtok?: number;
  /** USD per million output tokens. */
  completion_usd_per_mtok?: number;
  modality?: string;
}

export interface ProviderModelPage {
  provider: SharedProvider;
  models: ProviderModel[];
  /** Models matching the filter, before pagination. */
  total: number;
  page: number;
  pages: number;
}

export interface ListProviderModelsOptions {
  api_key?: string;
  base_url?: string;
  /** Case-insensitive substring match against id and name. */
  search?: string;
  limit?: number;
  page?: number;
}

const DEFAULT_LIMIT = 30;

/** Providers that publish a model catalog, with the base URL used when none is set. */
const CATALOG_DEFAULT_BASE_URL: Partial<Record<SharedProvider, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434",
};

/** openai-compatible has no default: the base URL is the whole point of it. */
const CATALOG_PROVIDERS: SharedProvider[] = [
  "openrouter",
  "openai",
  "groq",
  "ollama",
  "openai-compatible",
];

function stripTrailingSlashes(url: string): string {
  return url.replace(/\/+$/, "");
}

/** OpenRouter prices in USD per token, as a string. Per million reads better. */
function perMillion(price: unknown): number | undefined {
  const n = typeof price === "string" ? Number(price) : typeof price === "number" ? price : NaN;
  if (!Number.isFinite(n)) return undefined;
  return n * 1_000_000;
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Read one field off an untyped JSON node. */
function field(node: unknown, key: string): unknown {
  return node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined;
}

function rows(payload: unknown, key: string): unknown[] {
  const value = field(payload, key);
  return Array.isArray(value) ? value : [];
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function getJson(url: string, apiKey?: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: {
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
        "X-Title": "lore",
      },
    });
  } catch (error) {
    throw new LoreError("AI_UNAVAILABLE", `Cannot reach ${url}: ${(error as Error).message}`, {
      url,
    });
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 300);
    throw new LoreError("AI_UNAVAILABLE", `${url} returned ${response.status}. ${body}`, {
      url,
      status: response.status,
    });
  }
  return response.json();
}

function parseOpenAiShape(payload: unknown): ProviderModel[] {
  return rows(payload, "data").map((row): ProviderModel => {
    const pricing = field(row, "pricing");
    return {
      id: String(field(row, "id") ?? ""),
      name: str(field(row, "name")),
      // OpenRouter says context_length; Groq says context_window.
      context_length: num(field(row, "context_length")) ?? num(field(row, "context_window")),
      prompt_usd_per_mtok: perMillion(field(pricing, "prompt")),
      completion_usd_per_mtok: perMillion(field(pricing, "completion")),
      modality: str(field(field(row, "architecture"), "modality")),
    };
  });
}

function parseOllamaShape(payload: unknown): ProviderModel[] {
  return rows(payload, "models").map(
    (row): ProviderModel => ({
      id: String(field(row, "name") ?? ""),
      name: str(field(field(row, "details"), "parameter_size")),
    }),
  );
}

/**
 * Fetch, filter, and paginate a provider's model catalog.
 *
 * Every supported endpoint returns the whole catalog in one response, so the
 * paging here is over the parsed list. It exists to keep a 300-model answer
 * readable, not to save a round trip.
 */
export async function listProviderModels(
  provider: SharedProvider,
  opts: ListProviderModelsOptions = {},
): Promise<ProviderModelPage> {
  if (!CATALOG_PROVIDERS.includes(provider)) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Provider '${provider}' publishes no model catalog. Supported: ${CATALOG_PROVIDERS.join(", ")}.`,
    );
  }

  const baseUrl = opts.base_url ?? CATALOG_DEFAULT_BASE_URL[provider];
  if (!baseUrl) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Provider '${provider}' has no base URL. Set one with: lore sys provider set ${provider} --base-url <url>`,
    );
  }

  const root = stripTrailingSlashes(baseUrl);
  const isOllama = provider === "ollama";
  const url = isOllama ? `${root}/api/tags` : `${root}/models`;
  const payload = await getJson(url, opts.api_key);
  let models = isOllama ? parseOllamaShape(payload) : parseOpenAiShape(payload);

  models = models.filter((model) => model.id.length > 0);

  const search = opts.search?.toLowerCase();
  if (search) {
    models = models.filter(
      (model) =>
        model.id.toLowerCase().includes(search) ||
        (model.name?.toLowerCase().includes(search) ?? false),
    );
  }

  models.sort((a, b) => a.id.localeCompare(b.id));

  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const total = models.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const start = (page - 1) * limit;

  return { provider, models: models.slice(start, start + limit), total, page, pages };
}
