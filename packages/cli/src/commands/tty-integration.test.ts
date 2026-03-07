import { expect, test } from "bun:test";
import type { WorkerClient } from "@lore/worker";
import { setJsonOutput } from "../output.ts";
import { ingestAllCommand } from "./ingest.ts";
import { rebuildCommand } from "./rebuild.ts";
import { scanCommand } from "./scan.ts";

function createWorkerStub(overrides: Record<string, unknown>): WorkerClient {
  return overrides as unknown as WorkerClient;
}

async function withInteractiveTimers<T>(
  run: (state: { intervalCalls: number; clearCalls: number }) => Promise<T>,
): Promise<T> {
  const state = { intervalCalls: 0, clearCalls: 0 };
  const originalIsTTY = process.stdout.isTTY;
  const originalWrite = process.stdout.write.bind(process.stdout);
  const originalLog = console.log;
  const originalError = console.error;
  const originalCI = process.env.CI;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;

  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  process.stdout.write = (() => true) as typeof process.stdout.write;
  console.log = () => {};
  console.error = () => {};
  process.env.CI = "false";
  setJsonOutput(false);

  globalThis.setInterval = (((...args: Parameters<typeof setInterval>) => {
    state.intervalCalls += 1;
    return originalSetInterval(...args);
  }) as typeof setInterval);
  globalThis.clearInterval = (((timer: Parameters<typeof clearInterval>[0]) => {
    state.clearCalls += 1;
    return originalClearInterval(timer);
  }) as typeof clearInterval);

  try {
    return await run(state);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    process.stdout.write = originalWrite;
    console.log = originalLog;
    console.error = originalError;
    Object.defineProperty(process.stdout, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    if (originalCI === undefined) {
      delete process.env.CI;
    } else {
      process.env.CI = originalCI;
    }
    setJsonOutput(false);
  }
}

test("ingest starts the spinner before the long-running refresh resolves", async () => {
  let resolveIngest!: (value: Awaited<ReturnType<WorkerClient["ingestAll"]>>) => void;
  const worker = createWorkerStub({
    ingestAll: () =>
      new Promise<Awaited<ReturnType<WorkerClient["ingestAll"]>>>((resolve) => {
        resolveIngest = resolve;
      }),
  });

  await withInteractiveTimers(async (state) => {
    const command = ingestAllCommand(worker);
    await Promise.resolve();
    expect(state.intervalCalls).toBeGreaterThan(0);
    resolveIngest({
      scan: {
        duration_ms: 1,
        files_scanned: 1,
        files_skipped: 0,
        files_removed: 0,
        symbols_found: 1,
        files_failed: 0,
        languages: {},
      },
      ingest: {
        duration_ms: 1,
        files_ingested: 1,
        files_skipped: 0,
        files_failed: 0,
        files_removed: 0,
      },
    });
    await command;
    expect(state.clearCalls).toBeGreaterThan(0);
  });
});

test("scan clears the spinner interval before rethrowing worker errors", async () => {
  const worker = createWorkerStub({
    rescan: async () => {
      throw new Error("scan failed");
    },
  });

  await withInteractiveTimers(async (state) => {
    await expect(scanCommand(worker)).rejects.toThrow("scan failed");
    expect(state.intervalCalls).toBeGreaterThan(0);
    expect(state.clearCalls).toBeGreaterThan(0);
  });
});

test("rebuild clears the spinner interval before rethrowing worker errors", async () => {
  const worker = createWorkerStub({
    rebuild: async () => {
      throw new Error("rebuild failed");
    },
  });

  await withInteractiveTimers(async (state) => {
    await expect(rebuildCommand(worker)).rejects.toThrow("rebuild failed");
    expect(state.intervalCalls).toBeGreaterThan(0);
    expect(state.clearCalls).toBeGreaterThan(0);
  });
});
