import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installPrefix,
  isNewerVersion,
  updateCheckDisabled,
  updateCheckSpawnArgs,
} from "./update.ts";
import { loreInvoke, shellQuote } from "./self-invoke.ts";

test("isNewerVersion compares the three numbers, not the strings", () => {
  expect(isNewerVersion("0.1.1", "0.1.0")).toBe(true);
  expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
  expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
  // "10" sorts before "9" as a string, and after it as a number.
  expect(isNewerVersion("0.10.0", "0.9.0")).toBe(true);
  expect(isNewerVersion("0.1.0", "0.1.0")).toBe(false);
  expect(isNewerVersion("0.1.0", "0.1.1")).toBe(false);
});

test("isNewerVersion accepts a v prefix on either side", () => {
  expect(isNewerVersion("v0.1.1", "0.1.0")).toBe(true);
  expect(isNewerVersion("0.1.1", "v0.1.0")).toBe(true);
  expect(isNewerVersion("v0.1.0", "v0.1.0")).toBe(false);
});

test("a prerelease loses against the release it precedes", () => {
  expect(isNewerVersion("0.2.0-beta.1", "0.2.0")).toBe(false);
  expect(isNewerVersion("0.2.0", "0.2.0-beta.1")).toBe(true);
  expect(isNewerVersion("0.2.0-beta.2", "0.2.0-beta.1")).toBe(true);
});

test("installPrefix reads the layout install.sh writes", () => {
  expect(installPrefix("/home/u/.local/lib/lore/lore")).toBe("/home/u/.local");
  expect(installPrefix("/opt/lore/lib/lore/lore")).toBe("/opt/lore");
});

test("installPrefix refuses a path it did not write", () => {
  // Running from source: the binary is bun, not an installed lore.
  expect(installPrefix("/usr/local/bin/bun")).toBeNull();
  expect(installPrefix("/home/u/Work/lore/dist/lore")).toBeNull();
});

test("updateCheckSpawnArgs uses the CLI script when running from source", () => {
  const dir = mkdtempSync(join(tmpdir(), "lore-cli-entry-"));
  mkdirSync(join(dir, "cli", "src"), { recursive: true });
  const entry = join(dir, "cli", "src", "index.ts");
  writeFileSync(entry, "export {}\n");

  expect(updateCheckSpawnArgs("/usr/bin/bun", entry)).toEqual({
    command: "/usr/bin/bun",
    args: [entry, "sys", "update-check", "--refresh"],
  });
});

test("updateCheckSpawnArgs does not treat a test file as the CLI", () => {
  // bun test sets argv[1] to the test file. Passing it back would re-enter
  // the test runner instead of refreshing the cache.
  expect(updateCheckSpawnArgs("/usr/bin/bun", "/tmp/hooks.test.ts")).toEqual({
    command: "/usr/bin/bun",
    args: ["sys", "update-check", "--refresh"],
  });
});

test("updateCheckSpawnArgs uses the binary alone when compiled", () => {
  expect(updateCheckSpawnArgs("/home/u/.local/lib/lore/lore", "/$bunfs/root/lore")).toEqual({
    command: "/home/u/.local/lib/lore/lore",
    args: ["sys", "update-check", "--refresh"],
  });
});

test("shellQuote leaves a safe token bare and quotes a path with spaces", () => {
  expect(shellQuote("lore")).toBe("lore");
  expect(shellQuote("--queue")).toBe("--queue");
  expect(shellQuote("/opt/lore/lib/lore/lore")).toBe("/opt/lore/lib/lore/lore");
  expect(shellQuote("/opt/Lore Tools/lore")).toBe("'/opt/Lore Tools/lore'");
});

test("loreInvoke names a compiled binary and ignores a test entry", () => {
  expect(loreInvoke("/home/u/.local/lib/lore/lore", "/$bunfs/root/lore")).toEqual({
    command: "/home/u/.local/lib/lore/lore",
    args: [],
  });
  expect(loreInvoke("/usr/bin/bun", "/tmp/cli.test.ts")).toEqual({
    command: "lore",
    args: [],
  });
});

test("updateCheckDisabled reads the opt-out variable", () => {
  const original = process.env.LORE_NO_UPDATE_CHECK;
  try {
    delete process.env.LORE_NO_UPDATE_CHECK;
    expect(updateCheckDisabled()).toBe(false);
    process.env.LORE_NO_UPDATE_CHECK = "";
    expect(updateCheckDisabled()).toBe(false);
    process.env.LORE_NO_UPDATE_CHECK = "0";
    expect(updateCheckDisabled()).toBe(false);
    process.env.LORE_NO_UPDATE_CHECK = "1";
    expect(updateCheckDisabled()).toBe(true);
    process.env.LORE_NO_UPDATE_CHECK = "true";
    expect(updateCheckDisabled()).toBe(true);
  } finally {
    if (original === undefined) delete process.env.LORE_NO_UPDATE_CHECK;
    else process.env.LORE_NO_UPDATE_CHECK = original;
  }
});
