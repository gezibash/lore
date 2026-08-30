import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createWorkerClient, type WorkerClientOptions } from "./index.ts";
import {
  daemonEntryScript,
  daemonIsStale,
  daemonSpawnArgs,
  newestSourceMtimeMs,
  sourceRootForEntry,
} from "./daemon-client.ts";
import {
  acquireLoreLock,
  loreDaemonLockPath,
  loreSpawnLockPath,
  releaseLoreLock,
  type LoreDaemonPaths,
} from "./daemon-paths.ts";

function tempDaemonPaths(): LoreDaemonPaths {
  const baseDir = mkdtempSync(join(tmpdir(), "lore-daemon-lock-"));
  return {
    baseDir,
    socketPath: join(baseDir, "lored.sock"),
    statePath: join(baseDir, "state.json"),
    logPath: join(baseDir, "daemon.log"),
    dbPath: join(baseDir, "queue.sqlite"),
  };
}

/** What `process.argv[1]` holds inside a `bun build --compile` executable. */
const EMBEDDED_ARGV = "/$bunfs/root/lore";

function withArgv<T>(entry: string, run: () => T): T {
  const realArgv = process.argv[1]!;
  const realEnv = process.env.LORE_DAEMON_ENTRY;
  delete process.env.LORE_DAEMON_ENTRY;
  process.argv[1] = entry;
  try {
    return run();
  } finally {
    process.argv[1] = realArgv;
    if (realEnv === undefined) delete process.env.LORE_DAEMON_ENTRY;
    else process.env.LORE_DAEMON_ENTRY = realEnv;
  }
}

test("daemon spawn: a compiled binary gets no entry argument", () => {
  const paths = tempDaemonPaths();
  const serve = [
    "daemon",
    "serve",
    "--socket",
    paths.socketPath,
    "--db",
    paths.dbPath,
    "--log",
    paths.logPath,
  ];

  // The embedded path is not a file, so the binary runs its own subcommand.
  // Passed back, it becomes the command the child runs: the child exits, and
  // the parent reports only a start timeout.
  withArgv(EMBEDDED_ARGV, () => {
    expect(daemonEntryScript()).toBeNull();
    expect(daemonSpawnArgs(daemonEntryScript(), paths)).toEqual(serve);
  });

  // A source checkout runs a real script, and the child still needs it.
  const checkout = join(mkdtempSync(join(tmpdir(), "lore-entry-")), "index.ts");
  writeFileSync(checkout, "export const a = 1;\n");
  withArgv(checkout, () => {
    expect(daemonEntryScript()).toBe(checkout);
    expect(daemonSpawnArgs(daemonEntryScript(), paths)).toEqual([checkout, ...serve]);
  });

  // The override wins over argv when it names a file.
  withArgv(EMBEDDED_ARGV, () => {
    process.env.LORE_DAEMON_ENTRY = checkout;
    expect(daemonEntryScript()).toBe(checkout);
  });
});

test("daemon staleness: a compiled binary is never stale", () => {
  // Source mtimes do not describe code baked into a binary. Calling it stale
  // stops a daemon that the same sources cannot rebuild, so every later call
  // stops the replacement again.
  const started = { started_at: new Date(0).toISOString() };
  withArgv(EMBEDDED_ARGV, () => {
    expect(daemonIsStale(started)).toBeFalse();
  });
});

test("daemon lock: only the first acquirer wins while its pid is alive", () => {
  const lockPath = loreDaemonLockPath(tempDaemonPaths());
  expect(acquireLoreLock(lockPath)).toBeTrue();
  expect(acquireLoreLock(lockPath)).toBeFalse();
  releaseLoreLock(lockPath);
  expect(acquireLoreLock(lockPath)).toBeTrue();
});

test("daemon lock: respects a lock held by another live process", () => {
  const lockPath = loreDaemonLockPath(tempDaemonPaths());
  // pid 1 (launchd/init) is always alive and never ours.
  writeFileSync(lockPath, "1");
  expect(acquireLoreLock(lockPath)).toBeFalse();
  releaseLoreLock(lockPath);
  expect(readFileSync(lockPath, "utf-8")).toBe("1");
});

test("daemon lock: reclaims a stale lock with an unreadable pid", () => {
  const lockPath = loreDaemonLockPath(tempDaemonPaths());
  writeFileSync(lockPath, "not-a-pid");
  expect(acquireLoreLock(lockPath)).toBeTrue();
  expect(readFileSync(lockPath, "utf-8")).toBe(String(process.pid));
  releaseLoreLock(lockPath);
  expect(existsSync(lockPath)).toBeFalse();
});

test("daemon lock: the spawning CLI and the daemon hold different locks", () => {
  // They collide only if these paths ever converge: the CLI holds its lock
  // across the spawn, so a shared path would make the child it just started
  // see a live holder and exit without binding.
  const paths = tempDaemonPaths();
  expect(loreSpawnLockPath(paths)).not.toBe(loreDaemonLockPath(paths));
  expect(acquireLoreLock(loreSpawnLockPath(paths))).toBeTrue();
  expect(acquireLoreLock(loreDaemonLockPath(paths))).toBeTrue();
});

type MockWorkerClient = WorkerClientOptions["client"];

test("createWorkerClient delegates to provided client", async () => {
  let called = false;
  const result = {
    meta: {
      query: "q",
      generated_at: "2026-02-24T00:00:00.000Z",
      generated_in: "1ms",
      brief: false,
      scanned: {
        local_candidates: 0,
        returned_results: 0,
        return_limit: 20,
        vector_limit: 20,
        text_vector_candidates: 0,
        code_vector_candidates: 0,
        fused_candidates: 0,
        staleness_checks: 0,
        web_search_enabled: false,
        web_results: 0,
        journal_candidates: 0,
        journal_results: 0,
      },
      rerank: {
        enabled: false,
        attempted: false,
        applied: false,
        model: "rerank-v3.5",
        candidates: 0,
        reason: "disabled",
      },
      executive_summary: {
        enabled: false,
        attempted: false,
        generated: false,
        model: "qwen3:8b",
        model_id: "",
        reason: "disabled",
        source_matches: 0,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      },
      grounding: {
        enabled: true,
        attempted: false,
        exactness_detected: false,
        hits_total: 0,
        call_site_hits: 0,
        files_considered: 0,
        mode: "always-on",
        reason: "no-code-path",
      },
      structural_boost: {
        enabled: false,
        symbols_matched: 0,
        concepts_boosted: 0,
        boost_map: {},
      },
    },
    results: [],
  };

  const client = createWorkerClient({
    client: {
      query: async () => {
        called = true;
        return result;
      },
      shutdown: () => {},
    } as unknown as MockWorkerClient,
  });

  const queried = await client.query("q");
  expect(called).toBeTrue();
  expect(queried.meta.query).toBe("q");
});

test("stale-daemon detection: workspace root wins, node_modules is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-srcroot-"));
  mkdirSync(join(root, "packages/cli/src"), { recursive: true });
  mkdirSync(join(root, "packages/cli/node_modules/dep"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: ["packages/*"] }));
  // A nested package.json without `workspaces` must not be mistaken for the root,
  // or the scan misses every sibling package and the daemon looks fresh forever.
  writeFileSync(join(root, "packages/cli/package.json"), JSON.stringify({ name: "@lore/cli" }));
  const entry = join(root, "packages/cli/src/index.ts");
  writeFileSync(entry, "export const a = 1;\n");

  expect(sourceRootForEntry(entry)).toBe(root);

  const baseline = newestSourceMtimeMs(root);
  expect(baseline).not.toBeNull();

  // A dependency changing must not read as our own code changing.
  const vendored = join(root, "packages/cli/node_modules/dep/index.ts");
  writeFileSync(vendored, "export const vendored = 1;\n");
  utimesSync(vendored, new Date(), new Date(Date.now() + 60_000));
  expect(newestSourceMtimeMs(root)).toBe(baseline);

  // An edit to a sibling package is what should move the needle.
  mkdirSync(join(root, "packages/core/src"), { recursive: true });
  const sibling = join(root, "packages/core/src/engine.ts");
  writeFileSync(sibling, "export const b = 2;\n");
  utimesSync(sibling, new Date(), new Date(Date.now() + 60_000));
  expect(newestSourceMtimeMs(root)!).toBeGreaterThan(baseline!);

  // Non-TypeScript files are not code the daemon serves.
  const readme = join(root, "packages/core/src/NOTES.md");
  writeFileSync(readme, "notes\n");
  utimesSync(readme, new Date(), new Date(Date.now() + 120_000));
  expect(newestSourceMtimeMs(root)).toBeLessThan(Date.now() + 120_000);
});
