import type { WorkerClient } from "@lore/worker";
import type { ModelKind, ModelSort, SharedProvider } from "@lore/worker";
import {
  ALL_PROVIDERS,
  getDeepValue,
  GENERATION_PROMPT_KEYS,
  normalizePromptKey,
} from "@lore/worker";
import { emit, isJsonOutput } from "../output.ts";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";

// Numeric config keys that should be auto-coerced
const NUMERIC_KEYS = new Set([
  "chunking.target_tokens",
  "chunking.overlap",
  "thresholds.convergence",
  "thresholds.magnitude_epsilon",
  "thresholds.staleness_days",
  "thresholds.dangling_days",
  "thresholds.conflict_warn",
  "thresholds.theta_mixed",
  "thresholds.theta_critical",
  "thresholds.fiedler_drop",
  "rrf.k",
  "ai.embedding.dim",
  "ai.search.retrieval.return_limit",
  "ai.search.retrieval.vector_limit",
  "ai.search.rerank.candidates",
  "ai.search.rerank.max_chars",
  "ai.search.executive_summary.max_matches",
  "ai.search.executive_summary.max_chars",
  "ai.search.timeouts.embedding_ms",
  "ai.search.timeouts.rerank_ms",
  "ai.search.timeouts.executive_summary_ms",
]);

const BOOLEAN_KEYS = new Set(["ai.search.rerank.enabled", "ai.search.executive_summary.enabled"]);

// Keys to skip in `config show` — too verbose or internal
const SHOW_SKIP_PREFIXES = [
  "ai.generation.prompts",
  "lore_root",
  "rrf.lane_weights",
  "thresholds.max_log_n",
  "ai.search.retrieval_opts",
];

function flattenObject(obj: unknown, prefix = ""): Array<{ key: string; value: unknown }> {
  const result: Array<{ key: string; value: unknown }> = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      result.push(...flattenObject(v, key));
    } else {
      result.push({ key, value: v });
    }
  }
  return result;
}

function coerceValue(key: string, value: string): unknown {
  if (NUMERIC_KEYS.has(key)) {
    const num = Number(value);
    if (!isNaN(num)) return num;
  }
  if (BOOLEAN_KEYS.has(key)) {
    if (value === "true") return true;
    if (value === "false") return false;
  }
  return value;
}

function parseProvider(provider: string): SharedProvider {
  const normalized = provider.trim().toLowerCase();
  if (ALL_PROVIDERS.includes(normalized as SharedProvider)) {
    return normalized as SharedProvider;
  }
  throw new Error(`Unknown provider '${provider}'. Expected one of: ${ALL_PROVIDERS.join(", ")}`);
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export async function configGetCommand(client: WorkerClient, key: string): Promise<void> {
  const { config, resolved } = await client.getLoreMindConfig();

  const overrideValue = config ? getDeepValue(config as Record<string, unknown>, key) : undefined;
  const resolvedValue = getDeepValue(resolved as unknown as Record<string, unknown>, key);

  if (resolvedValue === undefined) {
    emit({ key, found: false }, () => `${DIM}Key '${key}' not found in config${RESET}`);
    return;
  }

  const source =
    overrideValue !== undefined
      ? `${CYAN}(lore override)${RESET}`
      : `${DIM}(default/global)${RESET}`;
  emit(
    { key, value: resolvedValue, override: overrideValue !== undefined },
    () => `${BOLD}${key}${RESET} = ${JSON.stringify(resolvedValue)}  ${source}`,
  );
}

export async function configShowCommand(
  client: WorkerClient,
  opts?: { overridesOnly?: boolean },
): Promise<void> {
  const { config: overrides, resolved } = await client.getLoreMindConfig();

  // Pre-compute all rows so column widths can be measured before rendering
  const rows = flattenObject(resolved)
    .filter(({ key }) => !SHOW_SKIP_PREFIXES.some((p) => key.startsWith(p)))
    .map(({ key, value }) => {
      const isOverride =
        overrides !== undefined &&
        getDeepValue(overrides as Record<string, unknown>, key) !== undefined;
      const rawDisplay =
        key.includes("api_key") && value
          ? maskSecret(String(value))
          : JSON.stringify(value ?? null);
      return { key, rawDisplay, isOverride };
    })
    .filter((row) => !opts?.overridesOnly || row.isOverride);

  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0;
  const headerNote = hasOverrides
    ? `${CYAN}has local overrides${RESET}`
    : `${DIM}all defaults${RESET}`;
  const payload = {
    overrides,
    resolved,
    rows: rows.map((row) => ({
      key: row.key,
      value: row.rawDisplay,
      override: row.isOverride,
    })),
  };
  emit(payload, () => {
    const lines = [
      `${BOLD}Config${RESET}  ${headerNote}`,
      `${DIM}Use 'lore sys config set <key> <value>' to override any key${RESET}`,
      "",
    ];
    if (rows.length === 0) return lines.join("\n");
    const KEY_COL = Math.max(20, ...rows.map((r) => r.key.length)) + 2;
    const VAL_COL = Math.max(8, ...rows.map((r) => r.rawDisplay.length)) + 2;
    for (const { key, rawDisplay, isOverride } of rows) {
      const keyStr = isOverride ? `${CYAN}${key}${RESET}` : `${DIM}${key}${RESET}`;
      const sourceBadge = isOverride ? `${CYAN}override${RESET}` : `${DIM}default${RESET} `;
      const keyPad = " ".repeat(KEY_COL - key.length);
      const valPad = " ".repeat(VAL_COL - rawDisplay.length);
      lines.push(`  ${keyStr}${keyPad}${rawDisplay}${valPad}${sourceBadge}`);
    }
    return lines.join("\n");
  });
}

export async function configSetCommand(
  client: WorkerClient,
  key: string,
  value: string,
): Promise<void> {
  const coerced = coerceValue(key, value);
  await client.setLoreMindConfig(key, coerced);
  emit(
    { key, value: coerced },
    () => `${GREEN}✓${RESET} Set ${BOLD}${key}${RESET} = ${JSON.stringify(coerced)}`,
  );
}

export async function configUnsetCommand(client: WorkerClient, key: string): Promise<void> {
  await client.unsetLoreMindConfig(key);
  emit({ key, unset: true }, () => `${GREEN}✓${RESET} Unset ${BOLD}${key}${RESET}`);
}

export async function configPromptPreviewCommand(client: WorkerClient, key: string): Promise<void> {
  const lower = key.trim().toLowerCase();
  const resolvedKey = lower === "all" ? "all" : normalizePromptKey(lower);
  if (!resolvedKey) {
    throw new Error(
      `Unknown prompt key '${key}'. Expected one of: ${GENERATION_PROMPT_KEYS.join(", ")} or all`,
    );
  }

  const previews = await client.getPromptPreview(resolvedKey);
  for (let i = 0; i < previews.length; i++) {
    const preview = previews[i]!;
    if (i > 0) console.log("");
    console.log(`${BOLD}${preview.key}${RESET}`);
    if (preview.guidance.trim()) {
      console.log(`${DIM}guidance:${RESET} ${preview.guidance}`);
    } else {
      console.log(`${DIM}guidance:${RESET} (none)`);
    }
    console.log("");
    console.log(preview.system);
  }
}

export async function configCloneCommand(client: WorkerClient, lore: string): Promise<void> {
  const result = await client.cloneLoreMindConfig(lore);
  emit(result, (value) =>
    value.hasConfig
      ? `${GREEN}✓${RESET} Cloned config overrides from ${BOLD}${CYAN}${value.source}${RESET} into current lore ${BOLD}${CYAN}${value.target}${RESET}.`
      : `${GREEN}✓${RESET} Source lore ${BOLD}${CYAN}${value.source}${RESET} has no config overrides; cleared overrides for current lore ${BOLD}${CYAN}${value.target}${RESET}.`,
  );
}

export async function providerConfigListCommand(client: WorkerClient): Promise<void> {
  const providers = await client.listProviders();

  if (isJsonOutput()) {
    emit(providers);
    return;
  }

  console.log(
    `${DIM}${padRight("PROVIDER", 20)}${padRight("KEY", 8)}${padRight("CATALOG", 16)}USED BY${RESET}`,
  );
  for (const row of providers) {
    const key = row.has_key ? `${GREEN}set${RESET}${padRight("", 5)}` : padRight("—", 8);
    const catalog = !row.has_catalog
      ? "no"
      : row.catalog_needs_base_url
        ? "needs base-url"
        : row.catalog_needs_key && !row.has_key
          ? "needs key"
          : "yes";
    console.log(
      `${CYAN}${padRight(row.provider, 20)}${RESET}${key}${DIM}${padRight(catalog, 16)}${RESET}${row.used_by.join(", ")}`,
    );
  }
}

export async function providerConfigGetCommand(
  client: WorkerClient,
  provider: string,
): Promise<void> {
  const parsedProvider = parseProvider(provider);
  const config = await client.getProviderCredential(parsedProvider);
  if (!config) {
    emit(
      { provider: parsedProvider, found: false },
      () => `${DIM}No shared credential for provider '${parsedProvider}'.${RESET}`,
    );
    return;
  }
  const apiKey = config.api_key ? maskSecret(config.api_key) : "(unset)";
  const baseUrl = config.base_url ?? "(unset)";
  emit(
    { provider: parsedProvider, api_key: apiKey, base_url: baseUrl },
    () => `${BOLD}${parsedProvider}${RESET}\napi_key: ${apiKey}\nbase_url: ${baseUrl}`,
  );
}

/** Right-align a number column so prices and context windows compare by eye. */
function padLeft(text: string, width: number): string {
  return text.length >= width ? text : " ".repeat(width - text.length) + text;
}

function padRight(text: string, width: number): string {
  return text.padEnd(width);
}

const ALL_KINDS: ModelKind[] = ["generation", "embedding", "other"];

function parseSort(sort: string | undefined): ModelSort | undefined {
  if (sort === undefined) return undefined;
  const normalized = sort.trim().toLowerCase();
  if (normalized === "id" || normalized === "price" || normalized === "context") {
    return normalized;
  }
  throw new Error(`Unknown sort '${sort}'. Expected one of: id, price, context`);
}

function parseScope(scope: string | undefined): "project" | "global" | undefined {
  if (scope === undefined) return undefined;
  const normalized = scope.trim().toLowerCase();
  if (normalized === "project" || normalized === "global") return normalized;
  throw new Error(`Unknown scope '${scope}'. Expected one of: project, global`);
}

function parseKinds(type: string | undefined): ModelKind[] | undefined {
  if (type === undefined) return undefined;
  const normalized = type.trim().toLowerCase();
  if (normalized === "generation" || normalized === "embedding" || normalized === "other") {
    return [normalized];
  }
  throw new Error(`Unknown type '${type}'. Expected one of: generation, embedding, other`);
}

/** A dead provider loses its own models, never the rest of the page. */
function printFailures(failures?: Array<{ provider: string; reason: string }>): void {
  for (const failure of failures ?? []) {
    console.log(`${DIM}! ${failure.provider} could not be listed: ${failure.reason}${RESET}`);
  }
}

function formatPrice(usdPerMtok: number | undefined): string {
  if (usdPerMtok === undefined) return "—";
  if (usdPerMtok === 0) return "free";
  return usdPerMtok < 1 ? `$${usdPerMtok.toFixed(3)}` : `$${usdPerMtok.toFixed(2)}`;
}

/** An embedding model has no output side; a zero there would read as "free". */
function outputPrice(model: { kind?: string; completion_usd_per_mtok?: number }): string {
  return model.kind === "embedding" ? "—" : formatPrice(model.completion_usd_per_mtok);
}

function formatContext(tokens: number | undefined): string {
  // Some catalogs report 0 for "not applicable", which reads as a real limit.
  if (tokens === undefined || tokens === 0) return "—";
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export async function providerModelsCommand(
  client: WorkerClient,
  provider: string | undefined,
  options: {
    search?: string;
    limit?: number;
    page?: number;
    sort?: string;
    type?: string;
    allKinds?: boolean;
  },
): Promise<void> {
  const sort = parseSort(options.sort);
  const kinds = options.allKinds ? ALL_KINDS : parseKinds(options.type);
  const shared = { search: options.search, limit: options.limit, page: options.page, sort, kinds };

  // No provider named means search every provider that can be listed right now.
  const parsedProvider = provider ? parseProvider(provider) : undefined;
  const result = parsedProvider
    ? await client.listProviderModels(parsedProvider, shared)
    : await client.listAllProviderModels(shared);

  if (isJsonOutput()) {
    emit(result);
    return;
  }

  const scope = parsedProvider ?? "any configured provider";
  if (result.total === 0) {
    const filter = options.search ? ` matching '${options.search}'` : "";
    console.log(`${DIM}No models${filter} from ${scope}.${RESET}`);
    printFailures(result.failures);
    return;
  }

  const crossProvider = parsedProvider === undefined;
  const priced = result.models.some((model) => model.prompt_usd_per_mtok !== undefined);
  const columns = [
    crossProvider ? padRight("PROVIDER", 20) : "",
    priced ? `${padLeft("CTX", 6)}  ${padLeft("IN/M", 8)}  ${padLeft("OUT/M", 8)}  ` : "",
    "MODEL",
  ].join("");
  console.log(`${DIM}${columns}${RESET}`);

  for (const model of result.models) {
    const source = crossProvider ? `${padRight(model.provider ?? "", 20)}` : "";
    const price = priced
      ? `${padLeft(formatContext(model.context_length), 6)}  ${padLeft(formatPrice(model.prompt_usd_per_mtok), 8)}  ${padLeft(outputPrice(model), 8)}  `
      : "";
    console.log(`${DIM}${source}${price}${RESET}${CYAN}${model.id}${RESET}`);
  }

  const shown = result.models.length;
  const first = (result.page - 1) * (options.limit ?? shown) + 1;
  console.log(
    `\n${DIM}${first}-${first + shown - 1} of ${result.total} · page ${result.page}/${result.pages}${RESET}`,
  );
  printFailures(result.failures);

  if (result.page < result.pages) {
    // Carry the filters into the hint: without them the next page is a different list.
    const flags = [
      options.search ? `--search ${options.search}` : "",
      options.sort ? `--sort ${options.sort}` : "",
      options.type ? `--type ${options.type}` : "",
      options.allKinds ? "--all-kinds" : "",
      options.limit ? `--limit ${options.limit}` : "",
      `--page ${result.page + 1}`,
    ]
      .filter(Boolean)
      .join(" ");
    const target = parsedProvider ? `${parsedProvider} ` : "";
    console.log(`${DIM}Next: lore sys provider models ${target}${flags}${RESET}`);
  }
}

function formatUsd(value: number | undefined): string {
  return value === undefined ? "—" : `$${value.toFixed(2)}`;
}

export async function providerUsageCommand(client: WorkerClient, provider: string): Promise<void> {
  const parsedProvider = parseProvider(provider);
  const usage = await client.getProviderUsage(parsedProvider);

  if (isJsonOutput()) {
    emit(usage);
    return;
  }

  const row = (label: string, value: string): void => {
    console.log(`${DIM}${padRight(label, 18)}${RESET}${value}`);
  };

  console.log(`${BOLD}${parsedProvider}${RESET}`);
  // Balance is the number that decides whether the next ask works, so it leads
  // and it is the one that gets coloured when it runs low.
  const balance = usage.balance_usd;
  const lowOnCredit = balance !== undefined && balance < 5;
  row("balance", `${lowOnCredit ? RED : GREEN}${formatUsd(balance)}${RESET}`);
  row("used", formatUsd(usage.used_usd));
  if (usage.limit_usd !== undefined) row("key limit", formatUsd(usage.limit_usd));
  if (usage.key_used_usd !== undefined) row("used by this key", formatUsd(usage.key_used_usd));
  if (usage.key_used_today_usd !== undefined) row("today", formatUsd(usage.key_used_today_usd));
  if (usage.key_used_month_usd !== undefined)
    row("this month", formatUsd(usage.key_used_month_usd));
  if (usage.free_tier) row("tier", "free");

  if (lowOnCredit) {
    console.log(`${RED}Low balance. Calls fail once it reaches zero.${RESET}`);
  }
}

export async function providerUseCommand(
  client: WorkerClient,
  provider: string,
  model: string,
  options: { embedding?: boolean; dim?: number; noVerify?: boolean; scope?: string },
): Promise<void> {
  const parsedProvider = parseProvider(provider);
  const role = options.embedding ? "embedding" : "generation";
  const scope = parseScope(options.scope);

  if (role === "embedding" && options.dim === undefined) {
    // No catalog reports embedding dimensions, so the caller must state it.
    throw new Error("Switching the embedding model needs --dim <n>, the new model's vector size.");
  }

  const result = await client.useModel(parsedProvider, model, {
    role,
    dim: options.dim,
    verify: !options.noVerify,
    scope,
  });

  if (isJsonOutput()) {
    emit(result);
    return;
  }

  const target = result.scope === "global" ? "Every lore" : "This lore";
  console.log(
    `${GREEN}✓${RESET} ${target} now uses ${BOLD}${CYAN}${result.model}${RESET} on ${BOLD}${result.provider}${RESET} for ${role}.`,
  );
  if (result.scope === "global") {
    console.log(`${DIM}Written to ~/.lore/config.json. A project override still wins.${RESET}`);
  }
  if (role === "embedding") {
    console.log(
      `${DIM}Run 'lore sys embeddings refresh' now. Until you do, every stored row keeps its old model tag and counts as stale.${RESET}`,
    );
  }
}

export async function providerConfigSetCommand(
  client: WorkerClient,
  provider: string,
  options: { apiKey?: string; baseUrl?: string },
): Promise<void> {
  const parsedProvider = parseProvider(provider);
  if (options.apiKey === undefined && options.baseUrl === undefined) {
    throw new Error("Provide at least one option: --api-key <value> or --base-url <value>");
  }
  await client.setProviderCredential(parsedProvider, {
    api_key: options.apiKey,
    base_url: options.baseUrl,
  });
  emit(
    { provider: parsedProvider, updated: true },
    () =>
      `${GREEN}✓${RESET} Updated shared provider credential for ${BOLD}${parsedProvider}${RESET}`,
  );
}

export async function providerConfigUnsetCommand(
  client: WorkerClient,
  provider: string,
  options: { apiKey?: boolean; baseUrl?: boolean },
): Promise<void> {
  const parsedProvider = parseProvider(provider);
  const clearApiKey = options.apiKey ?? false;
  const clearBaseUrl = options.baseUrl ?? false;
  const noSelectors = !clearApiKey && !clearBaseUrl;
  const next = await client.unsetProviderCredential(parsedProvider, {
    api_key: noSelectors ? true : clearApiKey,
    base_url: noSelectors ? true : clearBaseUrl,
  });
  if (!next) {
    emit(
      { provider: parsedProvider, found: false },
      () => `${DIM}No shared credential for provider '${parsedProvider}'.${RESET}`,
    );
    return;
  }
  emit(
    { provider: parsedProvider, credential: next },
    () =>
      `${GREEN}✓${RESET} Updated shared provider credential for ${BOLD}${parsedProvider}${RESET}`,
  );
}
