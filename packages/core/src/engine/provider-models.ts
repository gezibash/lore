/**
 * List the models a provider offers.
 *
 * Picking a model means knowing the exact id string, the context window, and
 * the price. Only the provider knows those, and each one publishes them at its
 * own endpoint in its own shape. This normalizes the six that expose a catalog
 * over HTTP; the rest have no such endpoint and say so.
 */
import { LoreError, type SharedProvider } from "@/types/index.ts";
import { OPENROUTER_ATTRIBUTION } from "./provider.ts";

/** What lore can configure a model as. Anything else it cannot use at all. */
export type ModelKind = "generation" | "embedding" | "other";

export interface ProviderModel {
  id: string;
  name?: string;
  /** Which role this model can fill, when the provider says. */
  kind?: ModelKind;
  /** Set only when the catalog spans several providers. */
  provider?: SharedProvider;
  /** Maximum context in tokens. */
  context_length?: number;
  /** USD per million input tokens. */
  prompt_usd_per_mtok?: number;
  /** USD per million output tokens. */
  completion_usd_per_mtok?: number;
  modality?: string;
}

export interface ProviderStatus {
  provider: SharedProvider;
  has_key: boolean;
  base_url?: string;
  has_catalog: boolean;
  /** The catalog endpoint rejects an anonymous request. */
  catalog_needs_key: boolean;
  /** The catalog has no default URL, so one must be stored first. */
  catalog_needs_base_url: boolean;
  /** Roles the current lore uses this provider for. Empty outside a lore. */
  used_by: string[];
}

export type ModelSort = "id" | "price" | "context";

export interface ProviderModelPage {
  /** The single provider queried, or "all" when the catalogs were merged. */
  provider: SharedProvider | "all";
  models: ProviderModel[];
  /** Models matching the filter, before pagination. */
  total: number;
  page: number;
  pages: number;
  /** Providers that could not be reached. The rest of the page is still valid. */
  failures?: Array<{ provider: SharedProvider; reason: string }>;
}

export interface ListProviderModelsOptions {
  api_key?: string;
  base_url?: string;
  /** Case-insensitive substring match against id and name. */
  search?: string;
  limit?: number;
  page?: number;
  /** Defaults to id. */
  sort?: ModelSort;
  /** Kinds to keep. Defaults to what lore can configure. */
  kinds?: ModelKind[];
}

const DEFAULT_LIMIT = 30;

/**
 * Vercel's catalog carries video, image, speech and reranking models lore can
 * never be configured with. Hiding them is the difference between 360 rows and
 * the 265 that mean something.
 */
const USABLE_KINDS: ModelKind[] = ["generation", "embedding"];

/** Providers that publish a model catalog, with the base URL used when none is set. */
const CATALOG_DEFAULT_BASE_URL: Partial<Record<SharedProvider, string>> = {
  openrouter: "https://openrouter.ai/api/v1",
  // The gateway provider is Vercel AI Gateway.
  gateway: "https://ai-gateway.vercel.sh/v1",
  openai: "https://api.openai.com/v1",
  groq: "https://api.groq.com/openai/v1",
  ollama: "http://localhost:11434",
};

/** openai-compatible has no default: the base URL is the whole point of it. */
/**
 * Every provider a credential can be stored for.
 *
 * The one list. A second hand-maintained copy in the CLI is what left `voyage`
 * unsettable for as long as it existed.
 */
export const ALL_PROVIDERS: SharedProvider[] = [
  "alibaba",
  "cohere",
  "gateway",
  "groq",
  "moonshotai",
  "ollama",
  "openai",
  "openai-compatible",
  "openrouter",
  "voyage",
];

const CATALOG_PROVIDERS: SharedProvider[] = [
  "openrouter",
  "gateway",
  "openai",
  "groq",
  "ollama",
  "openai-compatible",
];

/** Catalogs these providers serve without a key, so listing works unconfigured. */
export const CATALOG_NEEDS_KEY: SharedProvider[] = ["openai", "groq"];

/** Providers with a catalog but no default URL: the caller must supply one. */
export function catalogNeedsBaseUrl(provider: SharedProvider): boolean {
  return CATALOG_PROVIDERS.includes(provider) && !CATALOG_DEFAULT_BASE_URL[provider];
}

export function hasCatalog(provider: SharedProvider): boolean {
  return CATALOG_PROVIDERS.includes(provider);
}

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
        ...OPENROUTER_ATTRIBUTION,
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

/**
 * Vercel labels every model with a type. Nobody else does, and the only other
 * catalogs that carry pricing serve language models exclusively, so an absent
 * label means generation rather than unknown.
 */
function kindOf(row: unknown): ModelKind {
  switch (str(field(row, "type"))) {
    case "embedding":
      return "embedding";
    case undefined:
    case "language":
      return "generation";
    default:
      return "other";
  }
}

function parseOpenAiShape(payload: unknown): ProviderModel[] {
  return rows(payload, "data").map((row): ProviderModel => {
    const pricing = field(row, "pricing");
    return {
      id: String(field(row, "id") ?? ""),
      name: str(field(row, "name")),
      kind: kindOf(row),
      // OpenRouter says context_length; Groq and Vercel say context_window.
      context_length: num(field(row, "context_length")) ?? num(field(row, "context_window")),
      // OpenRouter prices under prompt/completion; Vercel under input/output.
      prompt_usd_per_mtok:
        perMillion(field(pricing, "prompt")) ?? perMillion(field(pricing, "input")),
      completion_usd_per_mtok:
        perMillion(field(pricing, "completion")) ?? perMillion(field(pricing, "output")),
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

function filterKinds(models: ProviderModel[], kinds?: ModelKind[]): ProviderModel[] {
  const wanted = kinds ?? USABLE_KINDS;
  return models.filter((model) => model.kind === undefined || wanted.includes(model.kind));
}

/**
 * Sort in place.
 *
 * A missing value always sorts last, never first. Ollama reports no price, and
 * a price-sorted list that opens with every unpriced local model answers the
 * opposite of the question that was asked.
 */
function sortModels(models: ProviderModel[], sort: ModelSort): void {
  if (sort === "id") {
    models.sort((a, b) => a.id.localeCompare(b.id));
    return;
  }
  const key = (model: ProviderModel): number | undefined =>
    sort === "price" ? model.prompt_usd_per_mtok : model.context_length;
  // Price ascends (cheapest first); context descends (roomiest first).
  const direction = sort === "price" ? 1 : -1;
  models.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (left === undefined && right === undefined) return a.id.localeCompare(b.id);
    if (left === undefined) return 1;
    if (right === undefined) return -1;
    if (left === right) return a.id.localeCompare(b.id);
    return (left - right) * direction;
  });
}

function paginate(
  models: ProviderModel[],
  provider: SharedProvider | "all",
  opts: { limit?: number; page?: number },
  failures?: Array<{ provider: SharedProvider; reason: string }>,
): ProviderModelPage {
  const limit = Math.max(1, opts.limit ?? DEFAULT_LIMIT);
  const total = models.length;
  const pages = Math.max(1, Math.ceil(total / limit));
  const page = Math.min(Math.max(1, opts.page ?? 1), pages);
  const start = (page - 1) * limit;
  return {
    provider,
    models: models.slice(start, start + limit),
    total,
    page,
    pages,
    ...(failures && failures.length > 0 ? { failures } : {}),
  };
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
  let models: ProviderModel[];

  if (isOllama) {
    models = parseOllamaShape(await getJson(`${root}/api/tags`, opts.api_key));
  } else {
    models = parseOpenAiShape(await getJson(`${root}/models`, opts.api_key));
    if (provider === "openrouter") {
      // OpenRouter's catalog defaults to text output, so its 34 embedding
      // models are absent from the plain list. They are a separate query, not
      // a missing feature.
      const embeddings = await getJson(
        `${root}/models?output_modalities=embeddings`,
        opts.api_key,
      ).catch(() => null);
      if (embeddings) {
        models.push(
          ...parseOpenAiShape(embeddings).map((model) => ({
            ...model,
            kind: "embedding" as ModelKind,
          })),
        );
      }
    }
  }

  models = models.filter((model) => model.id.length > 0);
  models = filterKinds(models, opts.kinds);

  const search = opts.search?.toLowerCase();
  if (search) {
    models = models.filter(
      (model) =>
        model.id.toLowerCase().includes(search) ||
        (model.name?.toLowerCase().includes(search) ?? false),
    );
  }

  sortModels(models, opts.sort ?? "id");

  return paginate(models, provider, opts);
}

/**
 * Merge several providers' catalogs into one page.
 *
 * One unreachable provider must not lose the others' models, so failures are
 * collected and reported alongside the results rather than thrown. This mirrors
 * webSearch(), which already treats a dead source as partial results.
 *
 * Sorting and paging happen after the merge, so `--sort price` compares across
 * providers instead of within each one.
 */
export async function listAllProviderModels(
  providers: Array<{ provider: SharedProvider; api_key?: string; base_url?: string }>,
  opts: Omit<ListProviderModelsOptions, "api_key" | "base_url"> = {},
): Promise<ProviderModelPage> {
  const settled = await Promise.allSettled(
    providers.map(async (entry) => {
      // Page inside each provider would truncate before the merge, so take all.
      const page = await listProviderModels(entry.provider, {
        api_key: entry.api_key,
        base_url: entry.base_url,
        search: opts.search,
        kinds: opts.kinds,
        limit: Number.MAX_SAFE_INTEGER,
      });
      return page.models.map((model) => ({ ...model, provider: entry.provider }));
    }),
  );

  const models: ProviderModel[] = [];
  const failures: Array<{ provider: SharedProvider; reason: string }> = [];
  settled.forEach((outcome, index) => {
    const provider = providers[index]!.provider;
    if (outcome.status === "fulfilled") {
      models.push(...outcome.value);
      return;
    }
    failures.push({ provider, reason: (outcome.reason as Error).message });
  });

  sortModels(models, opts.sort ?? "id");
  return paginate(models, "all", opts, failures);
}

export interface ProviderUsage {
  provider: SharedProvider;
  /** Credit remaining, in USD. Undefined when the provider reports no balance. */
  balance_usd?: number;
  /** Lifetime spend, in USD. */
  used_usd?: number;
  /** Spend limit on this key, in USD. */
  limit_usd?: number;
  /** Spend on this key alone, where the account total covers several keys. */
  key_used_usd?: number;
  key_used_today_usd?: number;
  key_used_month_usd?: number;
  free_tier?: boolean;
}

/** Providers that report a balance. Nobody else publishes one. */
const USAGE_PROVIDERS: SharedProvider[] = ["openrouter", "gateway"];

export function hasUsage(provider: SharedProvider): boolean {
  return USAGE_PROVIDERS.includes(provider);
}

function usd(value: unknown): number | undefined {
  const n = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read a provider's credit balance and spend.
 *
 * The two differ in shape and in what they even mean by a balance. OpenRouter
 * reports credits bought and credits used, so the remainder is a subtraction,
 * and it splits per-key spend from the account total. Vercel reports the
 * remainder directly and has no per-key view.
 */
export async function getProviderUsage(
  provider: SharedProvider,
  opts: { api_key?: string; base_url?: string } = {},
): Promise<ProviderUsage> {
  if (!hasUsage(provider)) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Provider '${provider}' reports no balance. Supported: ${USAGE_PROVIDERS.join(", ")}.`,
    );
  }
  if (!opts.api_key) {
    throw new LoreError(
      "CONFIG_INVALID",
      `Reading ${provider} usage needs a key. Set one with: lore sys provider set ${provider} --api-key <key>`,
    );
  }

  const root = stripTrailingSlashes(opts.base_url ?? CATALOG_DEFAULT_BASE_URL[provider]!);

  if (provider === "gateway") {
    const payload = await getJson(`${root}/credits`, opts.api_key);
    return {
      provider,
      balance_usd: usd(field(payload, "balance")),
      used_usd: usd(field(payload, "total_used")),
    };
  }

  // OpenRouter: /credits is the account, /key is this key. One dead endpoint
  // must not hide the other's numbers.
  const [credits, key] = await Promise.allSettled([
    getJson(`${root}/credits`, opts.api_key),
    getJson(`${root}/key`, opts.api_key),
  ]);

  const creditsData = credits.status === "fulfilled" ? field(credits.value, "data") : undefined;
  const keyData = key.status === "fulfilled" ? field(key.value, "data") : undefined;

  const total = usd(field(creditsData, "total_credits"));
  const used = usd(field(creditsData, "total_usage"));

  return {
    provider,
    balance_usd: total !== undefined && used !== undefined ? total - used : undefined,
    used_usd: used,
    limit_usd: usd(field(keyData, "limit")),
    key_used_usd: usd(field(keyData, "usage")),
    key_used_today_usd: usd(field(keyData, "usage_daily")),
    key_used_month_usd: usd(field(keyData, "usage_monthly")),
    free_tier:
      typeof field(keyData, "is_free_tier") === "boolean"
        ? (field(keyData, "is_free_tier") as boolean)
        : undefined,
  };
}

/**
 * Look up one model the bulk catalog does not list.
 *
 * OpenRouter's /models returns 396 entries and not one embedding model, though
 * it serves them and prices them. They surface only per model, so a miss in the
 * bulk list is not proof the model is unknown — it may just be the wrong list.
 *
 * The per-model response carries one entry per serving provider. Their prices
 * differ, so the cheapest is taken: it is the one a request routes to by
 * default.
 */
export async function getProviderModel(
  provider: SharedProvider,
  modelId: string,
  opts: { api_key?: string; base_url?: string } = {},
): Promise<ProviderModel | null> {
  // Only OpenRouter and Vercel document this per-model route.
  if (provider !== "openrouter" && provider !== "gateway") return null;

  const root = stripTrailingSlashes(opts.base_url ?? CATALOG_DEFAULT_BASE_URL[provider]!);
  let payload: unknown;
  try {
    payload = await getJson(`${root}/models/${modelId}/endpoints`, opts.api_key);
  } catch {
    return null;
  }

  const data = field(payload, "data") ?? payload;
  const id = str(field(data, "id"));
  if (!id) return null;

  const endpoints = rows(data, "endpoints");
  let prompt: number | undefined;
  let completion: number | undefined;
  let context: number | undefined;
  for (const endpoint of endpoints) {
    const pricing = field(endpoint, "pricing");
    const inPrice = perMillion(field(pricing, "prompt")) ?? perMillion(field(pricing, "input"));
    if (inPrice !== undefined && (prompt === undefined || inPrice < prompt)) {
      prompt = inPrice;
      completion = perMillion(field(pricing, "completion")) ?? perMillion(field(pricing, "output"));
    }
    const ctx = num(field(endpoint, "context_length")) ?? num(field(endpoint, "context_window"));
    if (ctx !== undefined && (context === undefined || ctx > context)) context = ctx;
  }

  const modality = str(field(field(data, "architecture"), "modality"));
  return {
    id,
    name: str(field(data, "name")),
    kind: modality?.includes("embedding") ? "embedding" : kindOf(data),
    context_length: context ?? num(field(data, "context_length")),
    prompt_usd_per_mtok: prompt,
    completion_usd_per_mtok: completion,
    modality,
  };
}
