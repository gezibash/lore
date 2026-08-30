import { expect, test } from "bun:test";
import { tmpdir } from "os";
import { getVersionString } from "./cli.ts";
import type { WorkerClient } from "@lore/worker";
import { runLoreCli } from "./cli.ts";

class ExitSignal extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

type TestRunResult = {
  exitCode?: number;
  stdout: string;
  stderr: string;
};

type TestRunOptions = {
  createWorker?: () => WorkerClient;
  stdinValues?: string[];
  versionString?: string;
};

async function runCliForTest(argv: string[], options: TestRunOptions = {}): Promise<TestRunResult> {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdinValues = [...(options.stdinValues ?? [])];

  const originalLog = console.log;
  const originalError = console.error;
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const originalExit = process.exit;
  const originalSetEncoding = process.stdin.setEncoding.bind(process.stdin);
  const originalOnce = process.stdin.once.bind(process.stdin);

  console.log = (...args: unknown[]) => {
    stdout.push(args.map(String).join(" "));
  };
  console.error = (...args: unknown[]) => {
    stderr.push(args.map(String).join(" "));
  };
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stderr.write;
  process.exit = ((code?: number) => {
    throw new ExitSignal(code ?? 0);
  }) as typeof process.exit;
  process.stdin.setEncoding = (() => process.stdin) as typeof process.stdin.setEncoding;
  process.stdin.once = ((event: string, listener: (...args: any[]) => void) => {
    if (event === "data") {
      listener(stdinValues.shift() ?? "");
      return process.stdin;
    }
    return originalOnce(event, listener);
  }) as typeof process.stdin.once;

  try {
    await runLoreCli(argv, {
      createWorker: options.createWorker,
      versionString: options.versionString ?? "9.9.9 (test)",
      exit: (code) => {
        throw new ExitSignal(code);
      },
    });
    return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: undefined };
  } catch (error) {
    if (error instanceof ExitSignal) {
      return { stdout: stdout.join(""), stderr: stderr.join(""), exitCode: error.code };
    }
    throw error;
  } finally {
    console.log = originalLog;
    console.error = originalError;
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
    process.stdin.setEncoding = originalSetEncoding;
    process.stdin.once = originalOnce;
  }
}

function createWorkerStub(overrides: Record<string, unknown>): WorkerClient {
  return overrides as unknown as WorkerClient;
}

test("root help renders the current top-level command surface", async () => {
  const result = await runCliForTest(["--help"]);
  expect(result.exitCode).toBeUndefined();
  expect(result.stdout).toContain("Knowledge system for codebases");
  expect(result.stdout).toContain("Usage: lore <command> [options]");
  expect(result.stdout).toContain("open [options] <narrative> <intent>");
  expect(result.stdout).toContain("sys [options]");
});

test("no arguments render root help without exiting non-zero", async () => {
  const result = await runCliForTest([]);
  expect(result.exitCode).toBeUndefined();
  expect(result.stdout).toContain("Usage: lore <command> [options]");
  expect(result.stderr).toBe("");
});

test("version output uses the injected version string", async () => {
  const result = await runCliForTest(["--version"], { versionString: "1.2.3 (fixture)" });
  expect(result.exitCode).toBeUndefined();
  expect(result.stdout.trim()).toBe("1.2.3 (fixture)");
});

test("non-json parse errors are rendered once through the CLI formatter", async () => {
  const result = await runCliForTest(["nope"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("error:");
  expect(result.stdout).toContain("unknown command 'nope'");
  expect(result.stdout).not.toContain("error: error:");
  expect(result.stderr).toBe("");
});

test("repeatable options do not leak implementation defaults into help output", async () => {
  const result = await runCliForTest(["open", "--help"]);
  expect(result.exitCode).toBeUndefined();
  expect(result.stdout).toContain("--target <string>");
  expect(result.stdout).not.toContain("(default: [])");
});

test("open accumulates repeated --target values", async () => {
  const calls: Array<Parameters<WorkerClient["open"]>> = [];
  const worker = createWorkerStub({
    open: async (...args: Parameters<WorkerClient["open"]>) => {
      calls.push(args);
      return {
        narrative: {
          name: args[0],
          intent: args[1],
        },
        context: null,
      } as unknown as Awaited<ReturnType<WorkerClient["open"]>>;
    },
  });

  const result = await runCliForTest(
    [
      "open",
      "auth-debug",
      "Investigate auth",
      "--target",
      "update:auth-model",
      "--target",
      "archive:old-auth:legacy",
      "--json",
    ],
    { createWorker: () => worker },
  );

  expect(result.exitCode).toBeUndefined();
  expect(calls).toHaveLength(1);
  expect(calls[0]?.[2]).toMatchObject({
    targets: [
      { op: "update", concept: "auth-model" },
      { op: "archive", concept: "old-auth", reason: "legacy" },
    ],
  });
});

test("log keeps the default positional limit of 20", async () => {
  const calls: Array<Parameters<WorkerClient["commitLog"]>[0]> = [];
  const worker = createWorkerStub({
    commitLog: async (opts: Parameters<WorkerClient["commitLog"]>[0]) => {
      calls.push(opts);
      return [];
    },
  });

  const result = await runCliForTest(["log"], { createWorker: () => worker });

  expect(result.exitCode).toBeUndefined();
  expect(calls).toEqual([{ limit: 20, since: undefined }]);
  expect(result.stdout).toContain("No commits yet");
});

test("ingest routes to ingestDoc when the optional file positional is present", async () => {
  const files: string[] = [];
  let ingestAllCalled = false;
  const worker = createWorkerStub({
    ingestDoc: async (file: Parameters<WorkerClient["ingestDoc"]>[0]) => {
      files.push(file);
      return {
        files_ingested: 1,
        files_skipped: 0,
        files_removed: 0,
        duration_ms: 1,
      };
    },
    ingestAll: async () => {
      ingestAllCalled = true;
      return {
        scan: {
          duration_ms: 1,
          files_scanned: 0,
          files_skipped: 0,
          files_removed: 0,
          symbols_found: 0,
          files_failed: 0,
          languages: {},
        },
        ingest: {
          duration_ms: 1,
          files_ingested: 0,
          files_skipped: 0,
          files_failed: 0,
          files_removed: 0,
        },
      };
    },
  });

  const result = await runCliForTest(["ingest", "README.md", "--json"], {
    createWorker: () => worker,
  });

  expect(result.exitCode).toBeUndefined();
  expect(files).toEqual(["README.md"]);
  expect(ingestAllCalled).toBe(false);
  expect(result.stdout).toContain('"kind": "file"');
});

test("nested sys narrative designate accumulates repeated --concept values", async () => {
  const calls: Array<Parameters<WorkerClient["designateJournalEntry"]>> = [];
  const worker = createWorkerStub({
    designateJournalEntry: async (...args: Parameters<WorkerClient["designateJournalEntry"]>) => {
      calls.push(args);
      return {
        narrative: args[0],
        chunk_id: args[1],
        concepts: args[2]?.concepts ?? [],
        note: null,
      } as unknown as Awaited<ReturnType<WorkerClient["designateJournalEntry"]>>;
    },
  });

  const result = await runCliForTest(
    [
      "sys",
      "narrative",
      "designate",
      "story",
      "chunk-1",
      "--concept",
      "auth-model",
      "--concept",
      "session-store",
      "--json",
    ],
    { createWorker: () => worker },
  );

  expect(result.exitCode).toBeUndefined();
  expect(calls[0]?.[2]).toEqual({ concepts: ["auth-model", "session-store"] });
  expect(result.stdout).toContain("chunk-1");
});

test("close preserves hyphenated flags and current manual validation semantics", async () => {
  const calls: Array<Parameters<WorkerClient["close"]>> = [];
  const worker = createWorkerStub({
    close: async (...args: Parameters<WorkerClient["close"]>) => {
      calls.push(args);
      return { queued: true } as unknown as Awaited<ReturnType<WorkerClient["close"]>>;
    },
  });

  const result = await runCliForTest(
    [
      "close",
      "auth-debug",
      "--mode",
      "not-a-mode",
      "--merge-strategy",
      "correct",
      "--from-result",
      "01ASK",
      "--poll-ms",
      "50",
      "--json",
    ],
    { createWorker: () => worker },
  );

  expect(result.exitCode).toBeUndefined();
  expect(calls[0]?.[1]).toMatchObject({
    mode: "merge",
    mergeStrategy: "correct",
    fromResultId: "01ASK",
    pollMs: 50,
    wait: false,
  });
  expect(result.stdout).toContain('"queued": true');
});

test("invalid recall section emits structured JSON errors when --json is present", async () => {
  const result = await runCliForTest(["recall", "01ASK", "--section", "bad", "--json"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain('"code": "CLI_ERROR"');
  expect(result.stdout).toContain("Invalid section 'bad'");
});

test("invalid recall section emits formatted text errors without --json", async () => {
  const result = await runCliForTest(["recall", "01ASK", "--section", "bad"]);
  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("Invalid section 'bad'");
  expect(result.stdout).not.toContain('"code": "CLI_ERROR"');
});

test("sys remove preserves the direct exit path for missing lores", async () => {
  const worker = createWorkerStub({
    listLoreMinds: async () => [],
  });

  const result = await runCliForTest(["sys", "remove", "missing", "--force"], {
    createWorker: () => worker,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toContain("No lore registered with name 'missing'");
});

test("sys remove prompt path can abort without deleting the lore", async () => {
  let removed = false;
  const worker = createWorkerStub({
    listLoreMinds: async () => [
      {
        name: "demo",
        code_path: "/repo",
        lore_path: "/repo/.lore",
        registered_at: "2026-03-07T00:00:00.000Z",
      },
    ],
    removeLoreMind: async () => {
      removed = true;
    },
  });

  const result = await runCliForTest(["sys", "remove", "demo"], {
    createWorker: () => worker,
    stdinValues: ["n\n"],
  });

  expect(result.exitCode).toBeUndefined();
  expect(result.stdout).toContain("Continue? [y/N] ");
  expect(result.stdout).toContain("Aborted.");
  expect(removed).toBe(false);
});

test("embeddings refresh failure keeps the current direct exit behavior", async () => {
  const worker = createWorkerStub({
    reEmbed: async () => {
      throw new Error("model unavailable");
    },
  });

  const result = await runCliForTest(["sys", "embeddings", "refresh"], {
    createWorker: () => worker,
  });

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("error: model unavailable");
});

test("the version does not report the caller's repository", () => {
  // A binary bakes LORE_BUILD_SHA at build time. From source that constant is
  // absent, and the git fallback must still answer for lore's own checkout —
  // not for whichever repository the process happens to be sitting in.
  const from = (cwd: string): string => {
    const previous = process.cwd();
    try {
      process.chdir(cwd);
      return getVersionString();
    } finally {
      process.chdir(previous);
    }
  };

  const here = from(process.cwd());
  const elsewhere = from(tmpdir());
  expect(elsewhere).toBe(here);
  // Source runs say so, so a stale binary cannot be mistaken for one.
  expect(here).toMatch(/from source|^\d+\.\d+\.\d+$/);
});
