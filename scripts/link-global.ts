#!/usr/bin/env bun

import { spawnSync } from "node:child_process";
import { mkdir, lstat, readlink, symlink, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliDir = resolve(repoRoot, "packages/cli");

const bunHome = process.env.BUN_INSTALL ?? resolve(homedir(), ".bun");
const binDir = resolve(bunHome, "bin");
const globalNodeModulesDir = resolve(bunHome, "install/global/node_modules");
const loreScopeDir = resolve(globalNodeModulesDir, "@lore");

const globalCliLink = resolve(loreScopeDir, "cli");
const workspaceLink = resolve(loreScopeDir, "workspace");
const binLink = resolve(binDir, "lore");
const binTarget = "../install/global/node_modules/@lore/cli/src/index.ts";

const registerResult = spawnSync("bun", ["link"], {
  cwd: cliDir,
  stdio: "inherit",
});

if (registerResult.status !== 0) {
  process.exit(registerResult.status ?? 1);
}

async function removeSymlinkIfPresent(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (!stats.isSymbolicLink()) {
      throw new Error(`${path} exists and is not a symlink`);
    }
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeWorkspaceLinkIfStale(): Promise<void> {
  try {
    const stats = await lstat(workspaceLink);
    if (!stats.isSymbolicLink()) {
      return;
    }

    const target = await readlink(workspaceLink);
    const resolvedTarget = resolve(dirname(workspaceLink), target);
    if (resolvedTarget === repoRoot) {
      await unlink(workspaceLink);
      console.log(`Removed stale Bun workspace link: ${workspaceLink}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

await mkdir(loreScopeDir, { recursive: true });
await mkdir(binDir, { recursive: true });

await removeWorkspaceLinkIfStale();
await removeSymlinkIfPresent(globalCliLink);
await symlink(cliDir, globalCliLink);
console.log(`Linked ${globalCliLink} -> ${cliDir}`);

await removeSymlinkIfPresent(binLink);
await symlink(binTarget, binLink);
console.log(`Linked ${binLink} -> ${binTarget}`);
