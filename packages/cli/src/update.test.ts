import { expect, test } from "bun:test";
import { installPrefix, isNewerVersion, updateCheckDisabled } from "./update.ts";

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
