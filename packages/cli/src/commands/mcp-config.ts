import { mkdir } from "fs/promises";
import { dirname, join } from "path";

export const LORE_MCP_SPEC_FILENAME = ".lore/mcp.json";
export const CLAUDE_MCP_CONFIG_FILENAME = ".mcp.json";
export const CODEX_MCP_CONFIG_FILENAME = ".codex/config.toml";
export const OPENCODE_MCP_CONFIG_FILENAME = "opencode.json";
export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";
export const MCP_SERVER_NAME = "lore";

export type ConfigStatus = "created" | "updated" | "unchanged";
export type McpHarness = "claude-code" | "codex" | "opencode";

export interface HarnessMcpConfigResult {
  harness: McpHarness;
  path: string;
  status: ConfigStatus;
  server: string;
}

export interface EnsureProjectMcpConfigOptions {
  harnesses?: McpHarness[];
}

export interface EnsureProjectMcpConfigResult {
  canonical: {
    path: string;
    status: ConfigStatus;
    server: string;
  };
  harnesses: HarnessMcpConfigResult[];
}

interface LoreMcpSpec {
  name: string;
  command: string;
  args: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function defaultLoreMcpSpec(): LoreMcpSpec {
  return {
    name: MCP_SERVER_NAME,
    command: "lore",
    args: ["mcp"],
  };
}

function defaultClaudeServerConfig(spec: LoreMcpSpec): Record<string, unknown> {
  return {
    command: spec.command,
    args: spec.args,
  };
}

function isLegacyAutoLoreServerConfig(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.command !== "bun") return false;
  if (!isStringArray(value.args)) return false;
  const args = value.args;
  return args.length >= 2 && args[args.length - 2] === "run" && args[args.length - 1] === "mcp";
}

function ensureLoreMcpSpec(value: unknown): LoreMcpSpec {
  if (!isRecord(value)) {
    throw new Error(`Expected ${LORE_MCP_SPEC_FILENAME} to contain a JSON object`);
  }
  if (typeof value.name !== "string" || value.name.trim().length === 0) {
    throw new Error(`Expected '${LORE_MCP_SPEC_FILENAME}.name' to be a non-empty string`);
  }
  if (typeof value.command !== "string" || value.command.trim().length === 0) {
    throw new Error(`Expected '${LORE_MCP_SPEC_FILENAME}.command' to be a non-empty string`);
  }
  if (!isStringArray(value.args)) {
    throw new Error(`Expected '${LORE_MCP_SPEC_FILENAME}.args' to be a string array`);
  }
  return {
    name: value.name,
    command: value.command,
    args: value.args,
  };
}

async function ensureParentDir(path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
}

async function ensureCanonicalMcpSpec(codePath: string): Promise<{
  path: string;
  status: ConfigStatus;
  spec: LoreMcpSpec;
}> {
  const path = join(codePath, LORE_MCP_SPEC_FILENAME);
  const file = Bun.file(path);
  const exists = await file.exists();
  if (!exists) {
    const spec = defaultLoreMcpSpec();
    await ensureParentDir(path);
    await Bun.write(path, `${JSON.stringify(spec, null, 2)}\n`);
    return {
      path,
      status: "created",
      spec,
    };
  }
  const text = await file.text();
  if (text.trim().length === 0) {
    throw new Error(`Expected ${LORE_MCP_SPEC_FILENAME} to contain a JSON object`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `Failed to parse ${LORE_MCP_SPEC_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return {
    path,
    status: "unchanged",
    spec: ensureLoreMcpSpec(parsed),
  };
}

async function ensureClaudeMcpConfig(
  codePath: string,
  spec: LoreMcpSpec,
): Promise<HarnessMcpConfigResult> {
  const configPath = join(codePath, CLAUDE_MCP_CONFIG_FILENAME);
  const file = Bun.file(configPath);
  const exists = await file.exists();

  const root: Record<string, unknown> = {};

  if (exists) {
    const text = await file.text();
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Failed to parse ${CLAUDE_MCP_CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!isRecord(parsed)) {
        throw new Error(`Expected ${CLAUDE_MCP_CONFIG_FILENAME} to contain a JSON object`);
      }

      Object.assign(root, parsed);
    }
  }

  const existingServers = root.mcpServers;
  const mcpServers: Record<string, unknown> =
    existingServers == null
      ? {}
      : isRecord(existingServers)
        ? { ...existingServers }
        : (() => {
            throw new Error(`Expected '${CLAUDE_MCP_CONFIG_FILENAME}.mcpServers' to be an object`);
          })();

  const existingLoreServer = mcpServers[spec.name];
  if (existingLoreServer !== undefined && !isLegacyAutoLoreServerConfig(existingLoreServer)) {
    return {
      harness: "claude-code",
      path: configPath,
      status: "unchanged",
      server: spec.name,
    };
  }

  mcpServers[spec.name] = defaultClaudeServerConfig(spec);
  root.mcpServers = mcpServers;

  await ensureParentDir(configPath);
  await Bun.write(configPath, `${JSON.stringify(root, null, 2)}\n`);

  return {
    harness: "claude-code",
    path: configPath,
    status: exists ? "updated" : "created",
    server: spec.name,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasCodexServerSection(text: string, serverName: string): boolean {
  const re = new RegExp(`^\\[mcp_servers\\.${escapeRegExp(serverName)}\\]\\s*$`, "m");
  return re.test(text);
}

function formatTomlStringArray(values: string[]): string {
  return `[${values.map((value) => JSON.stringify(value)).join(", ")}]`;
}

function renderCodexSection(spec: LoreMcpSpec): string {
  return [
    `[mcp_servers.${spec.name}]`,
    `command = ${JSON.stringify(spec.command)}`,
    `args = ${formatTomlStringArray(spec.args)}`,
    "",
  ].join("\n");
}

async function ensureCodexMcpConfig(
  codePath: string,
  spec: LoreMcpSpec,
): Promise<HarnessMcpConfigResult> {
  const configPath = join(codePath, CODEX_MCP_CONFIG_FILENAME);
  const file = Bun.file(configPath);
  const exists = await file.exists();
  const section = renderCodexSection(spec);

  if (!exists) {
    await ensureParentDir(configPath);
    await Bun.write(configPath, section);
    return {
      harness: "codex",
      path: configPath,
      status: "created",
      server: spec.name,
    };
  }

  const text = await file.text();
  if (hasCodexServerSection(text, spec.name)) {
    return {
      harness: "codex",
      path: configPath,
      status: "unchanged",
      server: spec.name,
    };
  }

  const separator = text.trim().length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n";
  await Bun.write(configPath, `${text}${separator}${section}`);
  return {
    harness: "codex",
    path: configPath,
    status: "updated",
    server: spec.name,
  };
}

function defaultOpenCodeServerConfig(spec: LoreMcpSpec): Record<string, unknown> {
  return {
    type: "local",
    command: [spec.command, ...spec.args],
    enabled: true,
  };
}

async function ensureOpenCodeMcpConfig(
  codePath: string,
  spec: LoreMcpSpec,
): Promise<HarnessMcpConfigResult> {
  const configPath = join(codePath, OPENCODE_MCP_CONFIG_FILENAME);
  const file = Bun.file(configPath);
  const exists = await file.exists();
  const root: Record<string, unknown> = {};

  if (exists) {
    const text = await file.text();
    if (text.trim().length > 0) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error(
          `Failed to parse ${OPENCODE_MCP_CONFIG_FILENAME}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!isRecord(parsed)) {
        throw new Error(`Expected ${OPENCODE_MCP_CONFIG_FILENAME} to contain a JSON object`);
      }
      Object.assign(root, parsed);
    }
  }

  const existingMcp = root.mcp;
  const mcp: Record<string, unknown> =
    existingMcp == null
      ? {}
      : isRecord(existingMcp)
        ? { ...existingMcp }
        : (() => {
            throw new Error(`Expected '${OPENCODE_MCP_CONFIG_FILENAME}.mcp' to be an object`);
          })();

  if (mcp[spec.name] !== undefined) {
    return {
      harness: "opencode",
      path: configPath,
      status: "unchanged",
      server: spec.name,
    };
  }

  mcp[spec.name] = defaultOpenCodeServerConfig(spec);
  root.mcp = mcp;
  if (root.$schema === undefined) {
    root.$schema = OPENCODE_CONFIG_SCHEMA;
  }

  await ensureParentDir(configPath);
  await Bun.write(configPath, `${JSON.stringify(root, null, 2)}\n`);

  return {
    harness: "opencode",
    path: configPath,
    status: exists ? "updated" : "created",
    server: spec.name,
  };
}

export async function ensureProjectMcpConfig(
  codePath: string,
  opts?: EnsureProjectMcpConfigOptions,
): Promise<EnsureProjectMcpConfigResult> {
  const canonical = await ensureCanonicalMcpSpec(codePath);
  const requested = opts?.harnesses && opts.harnesses.length > 0 ? opts.harnesses : undefined;
  const selectedHarnesses = requested
    ? Array.from(new Set(requested))
    : (["claude-code", "codex", "opencode"] as const);

  const harnessResults: HarnessMcpConfigResult[] = [];
  for (const harness of selectedHarnesses) {
    if (harness === "claude-code") {
      harnessResults.push(await ensureClaudeMcpConfig(codePath, canonical.spec));
      continue;
    }
    if (harness === "codex") {
      harnessResults.push(await ensureCodexMcpConfig(codePath, canonical.spec));
      continue;
    }
    if (harness === "opencode") {
      harnessResults.push(await ensureOpenCodeMcpConfig(codePath, canonical.spec));
      continue;
    }
    throw new Error(`Unknown MCP harness '${String(harness)}'`);
  }

  return {
    canonical: {
      path: canonical.path,
      status: canonical.status,
      server: canonical.spec.name,
    },
    harnesses: harnessResults,
  };
}
