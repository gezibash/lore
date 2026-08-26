#!/usr/bin/env bun
/**
 * Install lore as a stable command.
 *
 * `bun run link:global` points the `lore` command at the working tree, which
 * is what you want while developing: edits apply on the next invocation. This
 * installs the compiled build instead, so the command keeps working while the
 * tree is mid-edit, mid-rebase, or missing its node_modules.
 *
 * The build is copied out of dist/ rather than symlinked into it, because
 * rebuilding removes dist/ and would otherwise break the installed command.
 *
 * Note for anyone running npm here: npm treats a script named "install" as a
 * lifecycle hook and would run this during a dependency install. Bun does not.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const uninstall = args.includes("--uninstall");
const prefixArg = args.indexOf("--prefix");
const prefix = resolve(
  prefixArg !== -1 && args[prefixArg + 1]
    ? args[prefixArg + 1]!
    : (process.env.LORE_PREFIX ?? join(homedir(), ".local")),
);

const libDir = join(prefix, "lib", "lore");
const binLink = join(prefix, "bin", "lore");

/** Remove a path only when it is a symlink, so a real file is never deleted. */
function removeSymlink(path: string): boolean {
  try {
    if (!lstatSync(path).isSymbolicLink()) {
      throw new Error(`${path} exists and is not a symlink — remove it by hand`);
    }
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

if (uninstall) {
  const hadLink = removeSymlink(binLink);
  const hadLib = existsSync(libDir);
  rmSync(libDir, { recursive: true, force: true });
  console.log(hadLink || hadLib ? `Removed ${binLink} and ${libDir}` : "Nothing installed here.");
  process.exit(0);
}

const build = spawnSync("bun", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
if (build.status !== 0) process.exit(build.status ?? 1);

const dist = join(repoRoot, "dist");
if (!existsSync(join(dist, "lore"))) {
  console.error("Build produced no dist/lore.");
  process.exit(1);
}

mkdirSync(join(prefix, "bin"), { recursive: true });
mkdirSync(dirname(libDir), { recursive: true });
rmSync(libDir, { recursive: true, force: true });
cpSync(dist, libDir, { recursive: true });
removeSymlink(binLink);
symlinkSync(join(libDir, "lore"), binLink);

console.log(`\nInstalled ${libDir}`);
console.log(`Linked    ${binLink}`);

// An earlier PATH entry silently wins, and the symptom — an install that
// appears to do nothing — is hard to read. Name the shadow instead.
const found = Bun.which("lore");
if (!found) {
  console.warn(`\nWarning: ${dirname(binLink)} is not on PATH, so 'lore' will not resolve.`);
} else if (resolve(found) !== resolve(binLink)) {
  console.warn(`\nWarning: 'lore' still resolves to ${found}, which comes earlier on PATH.`);
  console.warn("Remove or rename that one for this install to take effect.");
}
