import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  ensureProjectMcpConfig,
  LORE_MCP_SPEC_FILENAME,
  CLAUDE_MCP_CONFIG_FILENAME,
  CODEX_MCP_CONFIG_FILENAME,
  OPENCODE_MCP_CONFIG_FILENAME,
  MCP_SERVER_NAME,
} from "./mcp-config.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "lore-mcp-config-"));
}

function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function findHarness(
  result: Awaited<ReturnType<typeof ensureProjectMcpConfig>>,
  harness: "claude-code" | "codex" | "opencode",
) {
  const found = result.harnesses.find((item) => item.harness === harness);
  if (!found) {
    throw new Error(`Missing harness result for ${harness}`);
  }
  return found;
}

test("ensureProjectMcpConfig creates canonical spec and all harness configs when missing", async () => {
  const dir = createTempDir();
  try {
    const result = await ensureProjectMcpConfig(dir);
    expect(result.canonical.status).toBe("created");
    expect(result.canonical.path).toBe(join(dir, LORE_MCP_SPEC_FILENAME));

    const spec = JSON.parse(await Bun.file(result.canonical.path).text()) as {
      name: string;
      command: string;
      args: string[];
    };
    expect(spec.name).toBe(MCP_SERVER_NAME);
    expect(spec.command).toBe("lore");
    expect(spec.args).toEqual(["mcp"]);

    const claude = findHarness(result, "claude-code");
    expect(claude.status).toBe("created");
    expect(claude.path).toBe(join(dir, CLAUDE_MCP_CONFIG_FILENAME));

    const claudeConfig = JSON.parse(await Bun.file(claude.path).text()) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(claudeConfig.mcpServers[MCP_SERVER_NAME]?.command).toBe("lore");
    expect(claudeConfig.mcpServers[MCP_SERVER_NAME]?.args).toEqual(["mcp"]);

    const codex = findHarness(result, "codex");
    expect(codex.status).toBe("created");
    expect(codex.path).toBe(join(dir, CODEX_MCP_CONFIG_FILENAME));
    const codexConfig = await Bun.file(codex.path).text();
    expect(codexConfig).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);
    expect(codexConfig).toContain(`command = "lore"`);
    expect(codexConfig).toContain(`args = ["mcp"]`);

    const opencode = findHarness(result, "opencode");
    expect(opencode.status).toBe("created");
    expect(opencode.path).toBe(join(dir, OPENCODE_MCP_CONFIG_FILENAME));

    const opencodeConfig = JSON.parse(await Bun.file(opencode.path).text()) as {
      $schema?: string;
      mcp: Record<string, { type: string; command: string[]; enabled: boolean }>;
    };
    expect(opencodeConfig.$schema).toBe("https://opencode.ai/config.json");
    expect(opencodeConfig.mcp[MCP_SERVER_NAME]?.type).toBe("local");
    expect(opencodeConfig.mcp[MCP_SERVER_NAME]?.command).toEqual(["lore", "mcp"]);
    expect(opencodeConfig.mcp[MCP_SERVER_NAME]?.enabled).toBe(true);
  } finally {
    removeTempDir(dir);
  }
});

test("ensureProjectMcpConfig updates existing harness config files by adding lore entries", async () => {
  const dir = createTempDir();
  try {
    const claudePath = join(dir, CLAUDE_MCP_CONFIG_FILENAME);
    await Bun.write(
      claudePath,
      `${JSON.stringify({ mcpServers: { other: { command: "node", args: ["server.js"] } } }, null, 2)}\n`,
    );
    const codexPath = join(dir, CODEX_MCP_CONFIG_FILENAME);
    await Bun.write(codexPath, '[mcp_servers.other]\ncommand = "node"\nargs = ["server.js"]\n');
    const opencodePath = join(dir, OPENCODE_MCP_CONFIG_FILENAME);
    await Bun.write(
      opencodePath,
      `${JSON.stringify({ mcp: { other: { type: "local", command: ["node", "server.js"] } } }, null, 2)}\n`,
    );

    const result = await ensureProjectMcpConfig(dir);
    expect(result.canonical.status).toBe("created");
    expect(findHarness(result, "claude-code").status).toBe("updated");
    expect(findHarness(result, "codex").status).toBe("updated");
    expect(findHarness(result, "opencode").status).toBe("updated");

    const claude = JSON.parse(await Bun.file(claudePath).text()) as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    expect(claude.mcpServers.other).toBeDefined();
    expect(claude.mcpServers[MCP_SERVER_NAME]).toBeDefined();

    const codex = await Bun.file(codexPath).text();
    expect(codex).toContain(`[mcp_servers.other]`);
    expect(codex).toContain(`[mcp_servers.${MCP_SERVER_NAME}]`);

    const opencode = JSON.parse(await Bun.file(opencodePath).text()) as {
      mcp: Record<string, unknown>;
    };
    expect(opencode.mcp.other).toBeDefined();
    expect(opencode.mcp[MCP_SERVER_NAME]).toBeDefined();
  } finally {
    removeTempDir(dir);
  }
});

test("ensureProjectMcpConfig keeps existing lore entries untouched across harnesses", async () => {
  const dir = createTempDir();
  try {
    const specPath = join(dir, LORE_MCP_SPEC_FILENAME);
    await Bun.write(
      specPath,
      `${JSON.stringify({ name: MCP_SERVER_NAME, command: "lore", args: ["mcp"] }, null, 2)}\n`,
    );

    const claudePath = join(dir, CLAUDE_MCP_CONFIG_FILENAME);
    await Bun.write(
      claudePath,
      `${JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: "custom-lore",
              args: ["serve"],
            },
          },
        },
        null,
        2,
      )}\n`,
    );
    const codexPath = join(dir, CODEX_MCP_CONFIG_FILENAME);
    await Bun.write(codexPath, `[mcp_servers.${MCP_SERVER_NAME}]\ncommand = "custom-lore"\n`);
    const opencodePath = join(dir, OPENCODE_MCP_CONFIG_FILENAME);
    await Bun.write(
      opencodePath,
      `${JSON.stringify(
        {
          mcp: {
            [MCP_SERVER_NAME]: {
              type: "local",
              command: ["custom-lore", "serve"],
              enabled: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const beforeClaude = await Bun.file(claudePath).text();
    const beforeCodex = await Bun.file(codexPath).text();
    const beforeOpenCode = await Bun.file(opencodePath).text();

    const result = await ensureProjectMcpConfig(dir);
    expect(result.canonical.status).toBe("unchanged");
    expect(findHarness(result, "claude-code").status).toBe("unchanged");
    expect(findHarness(result, "codex").status).toBe("unchanged");
    expect(findHarness(result, "opencode").status).toBe("unchanged");

    expect(await Bun.file(claudePath).text()).toBe(beforeClaude);
    expect(await Bun.file(codexPath).text()).toBe(beforeCodex);
    expect(await Bun.file(opencodePath).text()).toBe(beforeOpenCode);
  } finally {
    removeTempDir(dir);
  }
});

test("ensureProjectMcpConfig migrates legacy Claude bun run mcp entry to canonical lore mcp", async () => {
  const dir = createTempDir();
  try {
    const claudePath = join(dir, CLAUDE_MCP_CONFIG_FILENAME);
    await Bun.write(
      claudePath,
      `${JSON.stringify(
        {
          mcpServers: {
            [MCP_SERVER_NAME]: {
              command: "bun",
              args: ["--cwd", "/tmp/flowlake", "run", "mcp"],
              env: {},
            },
          },
        },
        null,
        2,
      )}\n`,
    );

    const result = await ensureProjectMcpConfig(dir);
    expect(findHarness(result, "claude-code").status).toBe("updated");

    const parsed = JSON.parse(await Bun.file(claudePath).text()) as {
      mcpServers: Record<string, { command?: string; args?: string[] }>;
    };
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.command).toBe("lore");
    expect(parsed.mcpServers[MCP_SERVER_NAME]?.args).toEqual(["mcp"]);
  } finally {
    removeTempDir(dir);
  }
});

test("ensureProjectMcpConfig supports selective harness generation", async () => {
  const dir = createTempDir();
  try {
    const result = await ensureProjectMcpConfig(dir, {
      harnesses: ["claude-code", "codex"],
    });
    expect(result.canonical.status).toBe("created");
    expect(result.harnesses.length).toBe(2);
    expect(result.harnesses.map((item) => item.harness).sort()).toEqual(["claude-code", "codex"]);

    expect(await Bun.file(join(dir, CLAUDE_MCP_CONFIG_FILENAME)).exists()).toBe(true);
    expect(await Bun.file(join(dir, CODEX_MCP_CONFIG_FILENAME)).exists()).toBe(true);
    expect(await Bun.file(join(dir, OPENCODE_MCP_CONFIG_FILENAME)).exists()).toBe(false);
  } finally {
    removeTempDir(dir);
  }
});
