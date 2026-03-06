import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { WorkerClient } from "@lore/worker";
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

test("registerCommand initializes the lore without creating editor config files", async () => {
  const dir = createTempDir();
  try {
    await withStubbedConsoleLog(async () => {
      await registerCommand(createWorkerClientStub(), dir);
    });

    expect(readdirSync(dir)).toEqual([]);
  } finally {
    removeTempDir(dir);
  }
});
