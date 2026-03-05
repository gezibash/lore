import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkerClient } from "@lore/worker";
import {
  LORE_MCP_SPEC_FILENAME,
  CLAUDE_MCP_CONFIG_FILENAME,
  CODEX_MCP_CONFIG_FILENAME,
  OPENCODE_MCP_CONFIG_FILENAME,
} from "./mcp-config.ts";
import { registerCommand } from "./register.ts";

function createTempDir(): string {
  return mkdtempSync(join(tmpdir(), "lore-register-command-"));
}

function removeTempDir(path: string): void {
  rmSync(path, { recursive: true, force: true });
}

function createWorkerClientStub(): WorkerClient {
  return {
    register: async (path: string) => ({
      lore_path: join(path, ".lore", "mind"),
      ready: true,
    }),
  } as unknown as WorkerClient;
}

function withStubbedConsoleLog(fn: () => Promise<void>): Promise<void> {
  const original = console.log;
  console.log = () => {};
  return fn().finally(() => {
    console.log = original;
  });
}

test("registerCommand does not generate MCP configs when no harness flags are provided", async () => {
  const dir = createTempDir();
  try {
    await withStubbedConsoleLog(async () => {
      await registerCommand(createWorkerClientStub(), dir);
    });

    expect(await Bun.file(join(dir, LORE_MCP_SPEC_FILENAME)).exists()).toBe(false);
    expect(await Bun.file(join(dir, CLAUDE_MCP_CONFIG_FILENAME)).exists()).toBe(false);
    expect(await Bun.file(join(dir, CODEX_MCP_CONFIG_FILENAME)).exists()).toBe(false);
    expect(await Bun.file(join(dir, OPENCODE_MCP_CONFIG_FILENAME)).exists()).toBe(false);
  } finally {
    removeTempDir(dir);
  }
});

test("registerCommand generates only selected MCP harness configs", async () => {
  const dir = createTempDir();
  try {
    await withStubbedConsoleLog(async () => {
      await registerCommand(createWorkerClientStub(), dir, undefined, {
        harnesses: ["claude-code"],
      });
    });

    expect(await Bun.file(join(dir, LORE_MCP_SPEC_FILENAME)).exists()).toBe(true);
    expect(await Bun.file(join(dir, CLAUDE_MCP_CONFIG_FILENAME)).exists()).toBe(true);
    expect(await Bun.file(join(dir, CODEX_MCP_CONFIG_FILENAME)).exists()).toBe(false);
    expect(await Bun.file(join(dir, OPENCODE_MCP_CONFIG_FILENAME)).exists()).toBe(false);
  } finally {
    removeTempDir(dir);
  }
});
