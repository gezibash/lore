import { join } from "path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import type { Registry, RegistryEntry, ProviderCredential, SharedProvider } from "@/types/index.ts";

const REGISTRY_FILE = "registry.json";

function registryPath(root: string): string {
  return join(root, REGISTRY_FILE);
}

function normalizeRegistry(raw: unknown): Registry {
  if (raw == null || typeof raw !== "object") return { lore_minds: {} };
  const parsed = raw as { lore_minds?: unknown; providers?: unknown };
  const loreMinds =
    parsed.lore_minds && typeof parsed.lore_minds === "object"
      ? (parsed.lore_minds as Registry["lore_minds"])
      : {};
  const providers =
    parsed.providers && typeof parsed.providers === "object"
      ? (parsed.providers as Registry["providers"])
      : undefined;
  return { lore_minds: loreMinds, ...(providers ? { providers } : {}) };
}

export function loadRegistry(root: string): Registry {
  const path = registryPath(root);
  if (!existsSync(path)) return { lore_minds: {} };
  try {
    return normalizeRegistry(JSON.parse(readFileSync(path, "utf-8")));
  } catch {
    return { lore_minds: {} };
  }
}

export function saveRegistry(root: string, reg: Registry): void {
  mkdirSync(root, { recursive: true });
  writeFileSync(registryPath(root), JSON.stringify(reg, null, 2) + "\n");
}

export function findLoreMindByCodePath(
  reg: Registry,
  codePath: string,
): { name: string; entry: RegistryEntry } | null {
  for (const [name, entry] of Object.entries(reg.lore_minds)) {
    if (entry.code_path === codePath) return { name, entry };
  }
  return null;
}

export function addLoreMind(
  root: string,
  reg: Registry,
  name: string,
  codePath: string,
  lorePath: string,
): Registry {
  const updated: Registry = {
    ...reg,
    lore_minds: {
      ...reg.lore_minds,
      [name]: {
        code_path: codePath,
        lore_path: lorePath,
        registered_at: new Date().toISOString(),
      },
    },
  };
  saveRegistry(root, updated);
  return updated;
}

export function listLoreMinds(reg: Registry): Array<{ name: string } & RegistryEntry> {
  return Object.entries(reg.lore_minds).map(([name, entry]) => ({
    name,
    ...entry,
  }));
}

export function removeLoreMind(root: string, reg: Registry, name: string): Registry {
  const { [name]: _, ...rest } = reg.lore_minds;
  const updated: Registry = {
    ...reg,
    lore_minds: rest,
  };
  saveRegistry(root, updated);
  return updated;
}


export function listProviderConfigs(
  reg: Registry,
): Array<{ provider: SharedProvider; config: ProviderCredential }> {
  if (!reg.providers) return [];
  return Object.entries(reg.providers)
    .filter(([, cfg]) => Boolean(cfg))
    .map(([provider, config]) => ({
      provider: provider as SharedProvider,
      config: config!,
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

export function getProviderConfig(
  reg: Registry,
  provider: SharedProvider,
): ProviderCredential | undefined {
  return reg.providers?.[provider];
}

export function updateProviderConfig(
  root: string,
  reg: Registry,
  provider: SharedProvider,
  config: ProviderCredential | undefined,
): Registry {
  const providers: Partial<Record<SharedProvider, ProviderCredential>> = {
    ...reg.providers,
  };

  if (!config || (config.api_key === undefined && config.base_url === undefined)) {
    delete providers[provider];
  } else {
    const next: ProviderCredential = {};
    if (config.api_key !== undefined) next.api_key = config.api_key;
    if (config.base_url !== undefined) next.base_url = config.base_url;
    providers[provider] = next;
  }

  const hasProviders = Object.keys(providers).length > 0;
  const updated: Registry = {
    ...reg,
    ...(hasProviders ? { providers } : {}),
  };
  if (!hasProviders) {
    delete (updated as { providers?: unknown }).providers;
  }
  saveRegistry(root, updated);
  return updated;
}
