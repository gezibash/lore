import type { WorkerClient } from "@lore/worker";
import type { SharedProvider } from "@lore/worker";
import { getDeepValue, GENERATION_PROMPT_KEYS, normalizePromptKey } from "@lore/worker";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const CYAN = "\x1b[36m";
const GREEN = "\x1b[32m";

const SHARED_PROVIDERS: SharedProvider[] = [
  "alibaba",
  "cohere",
  "gateway",
  "groq",
  "ollama",
  "openai",
  "openai-compatible",
  "openrouter",
  "moonshotai",
];

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
  if (SHARED_PROVIDERS.includes(normalized as SharedProvider)) {
    return normalized as SharedProvider;
  }
  throw new Error(
    `Unknown provider '${provider}'. Expected one of: ${SHARED_PROVIDERS.join(", ")}`,
  );
}

function maskSecret(value: string): string {
  if (value.length <= 8) return "********";
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

export async function configGetCommand(client: WorkerClient, key: string): Promise<void> {
  const { config, resolved } = client.getLoreMindConfig();

  const overrideValue = config ? getDeepValue(config as Record<string, unknown>, key) : undefined;
  const resolvedValue = getDeepValue(resolved as unknown as Record<string, unknown>, key);

  if (resolvedValue === undefined) {
    console.log(`${DIM}Key '${key}' not found in config${RESET}`);
    return;
  }

  const source =
    overrideValue !== undefined
      ? `${CYAN}(lore override)${RESET}`
      : `${DIM}(default/global)${RESET}`;
  console.log(`${BOLD}${key}${RESET} = ${JSON.stringify(resolvedValue)}  ${source}`);
}

export async function configShowCommand(
  client: WorkerClient,
  opts?: { overridesOnly?: boolean },
): Promise<void> {
  const { config: overrides, resolved } = client.getLoreMindConfig();

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
  console.log(`${BOLD}Config${RESET}  ${headerNote}`);
  console.log(`${DIM}Use 'lore mind config set <key> <value>' to override any key${RESET}`);
  console.log("");

  if (rows.length === 0) return;

  // Column widths sized to actual content + 2-space gap
  const KEY_COL = Math.max(20, ...rows.map((r) => r.key.length)) + 2;
  const VAL_COL = Math.max(8, ...rows.map((r) => r.rawDisplay.length)) + 2;

  for (const { key, rawDisplay, isOverride } of rows) {
    const keyStr = isOverride ? `${CYAN}${key}${RESET}` : `${DIM}${key}${RESET}`;
    const sourceBadge = isOverride ? `${CYAN}override${RESET}` : `${DIM}default${RESET} `;
    const keyPad = " ".repeat(KEY_COL - key.length);
    const valPad = " ".repeat(VAL_COL - rawDisplay.length);
    console.log(`  ${keyStr}${keyPad}${rawDisplay}${valPad}${sourceBadge}`);
  }
}

export async function configSetCommand(
  client: WorkerClient,
  key: string,
  value: string,
): Promise<void> {
  const coerced = coerceValue(key, value);
  client.setLoreMindConfig(key, coerced);
  console.log(`${GREEN}✓${RESET} Set ${BOLD}${key}${RESET} = ${JSON.stringify(coerced)}`);
}

export async function configUnsetCommand(client: WorkerClient, key: string): Promise<void> {
  client.unsetLoreMindConfig(key);
  console.log(`${GREEN}✓${RESET} Unset ${BOLD}${key}${RESET}`);
}

export async function configPromptPreviewCommand(client: WorkerClient, key: string): Promise<void> {
  const lower = key.trim().toLowerCase();
  const resolvedKey = lower === "all" ? "all" : normalizePromptKey(lower);
  if (!resolvedKey) {
    throw new Error(
      `Unknown prompt key '${key}'. Expected one of: ${GENERATION_PROMPT_KEYS.join(", ")} or all`,
    );
  }

  const previews = client.getPromptPreview(resolvedKey);
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
  const result = client.cloneLoreMindConfig(lore);
  if (!result.hasConfig) {
    console.log(
      `${GREEN}✓${RESET} Source lore mind ${BOLD}${CYAN}${result.source}${RESET} has no config overrides; cleared overrides for current lore mind ${BOLD}${CYAN}${result.target}${RESET}.`,
    );
    return;
  }

  console.log(
    `${GREEN}✓${RESET} Cloned config overrides from ${BOLD}${CYAN}${result.source}${RESET} into current lore mind ${BOLD}${CYAN}${result.target}${RESET}.`,
  );
}

export async function providerConfigListCommand(client: WorkerClient): Promise<void> {
  const providers = client.listProviderCredentials();
  if (providers.length === 0) {
    console.log(`${DIM}No shared provider credentials configured.${RESET}`);
    return;
  }

  for (const row of providers) {
    const apiKey = row.config.api_key ? maskSecret(row.config.api_key) : "(unset)";
    const baseUrl = row.config.base_url ?? "(unset)";
    console.log(`${BOLD}${row.provider}${RESET}`);
    console.log(`  api_key: ${apiKey}`);
    console.log(`  base_url: ${baseUrl}`);
  }
}

export async function providerConfigGetCommand(
  client: WorkerClient,
  provider: string,
): Promise<void> {
  const parsedProvider = parseProvider(provider);
  const config = client.getProviderCredential(parsedProvider);
  if (!config) {
    console.log(`${DIM}No shared credential for provider '${parsedProvider}'.${RESET}`);
    return;
  }
  const apiKey = config.api_key ? maskSecret(config.api_key) : "(unset)";
  const baseUrl = config.base_url ?? "(unset)";
  console.log(`${BOLD}${parsedProvider}${RESET}`);
  console.log(`api_key: ${apiKey}`);
  console.log(`base_url: ${baseUrl}`);
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
  client.setProviderCredential(parsedProvider, {
    api_key: options.apiKey,
    base_url: options.baseUrl,
  });
  console.log(
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
  const next = client.unsetProviderCredential(parsedProvider, {
    apiKey: noSelectors ? true : clearApiKey,
    baseUrl: noSelectors ? true : clearBaseUrl,
  });
  if (!next) {
    console.log(`${DIM}No shared credential for provider '${parsedProvider}'.${RESET}`);
    return;
  }
  console.log(
    `${GREEN}✓${RESET} Updated shared provider credential for ${BOLD}${parsedProvider}${RESET}`,
  );
}
