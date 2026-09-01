/**
 * Git hook lifecycle.
 *
 * Lore reads the index it built at the last ingest. After an edit that index
 * is behind, and nothing says so: `lore ask` answers from the old chunks. The
 * hook closes that gap at the one moment the working tree is settled and the
 * change is complete, which is the commit.
 *
 * The hook queues the work and returns. It never runs a scan itself, because a
 * commit must not wait for one.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";

const HOOK_NAME = "post-commit";

/** Marks a hook as written by lore. Present in every version lore has written,
 *  so it must never change: it is how uninstall knows the file is ours. */
const MARKER = "# lore:post-commit";

const HOOK_BODY = `#!/bin/sh
${MARKER}
# Queues a lore ingest after a commit. Managed by \`lore sys hooks install\`.
# Remove it with \`lore sys hooks uninstall\`.
#
# The hook must never fail a commit and must never delay one, so it ignores
# every error and asks lore to queue the scan instead of running it.
command -v lore >/dev/null 2>&1 || exit 0
lore ingest --queue >/dev/null 2>&1 || true
exit 0
`;

function git(args: string[], cwd: string): string | null {
  // env is passed rather than inherited: bun does not carry a change made to
  // process.env into a spawned child, and the git config environment decides
  // what this reads.
  const run = spawnSync("git", args, { cwd, encoding: "utf-8", env: process.env });
  if (run.status !== 0) return null;
  return run.stdout.trim();
}

export type HooksTarget =
  | { kind: "ok"; dir: string; path: string }
  /** `core.hooksPath` points outside the repository. */
  | { kind: "shared"; hooksPath: string }
  | { kind: "not-a-repo" };

/**
 * Where this repository's hooks belong, or why lore must not write one.
 *
 * `core.hooksPath` decides this, not the presence of `.git/hooks`. When it is
 * set, git runs that directory and ignores `.git/hooks` entirely, so writing
 * the hook to `.git/hooks` would install a file git never runs and report
 * success for a hook that does nothing.
 *
 * A `core.hooksPath` outside the repository is usually the global one, shared
 * by every repository the user owns. Writing there would install this hook in
 * all of them and overwrite whatever already serves them — git-lfs keeps its
 * `post-commit` in exactly that place. lore refuses instead.
 */
export function resolveHooksTarget(cwd = process.cwd()): HooksTarget {
  const top = git(["rev-parse", "--show-toplevel"], cwd);
  if (!top) return { kind: "not-a-repo" };

  const configured = git(["config", "--get", "core.hooksPath"], cwd);
  if (configured) {
    const dir = isAbsolute(configured) ? configured : resolve(top, configured);
    if (!resolve(dir).startsWith(resolve(top))) {
      return { kind: "shared", hooksPath: dir };
    }
    return { kind: "ok", dir, path: join(dir, HOOK_NAME) };
  }

  // --git-path resolves a worktree and a submodule to the real git directory.
  const hooks = git(["rev-parse", "--git-path", "hooks"], cwd);
  if (!hooks) return { kind: "not-a-repo" };
  const dir = isAbsolute(hooks) ? hooks : resolve(top, hooks);
  return { kind: "ok", dir, path: join(dir, HOOK_NAME) };
}

export type HookState =
  | { kind: "absent" }
  | { kind: "installed"; current: boolean }
  /** A hook is there and lore did not write it. */
  | { kind: "foreign" };

export function readHookState(path: string): HookState {
  if (!existsSync(path)) return { kind: "absent" };
  let body: string;
  try {
    body = readFileSync(path, "utf-8");
  } catch {
    return { kind: "foreign" };
  }
  if (!body.includes(MARKER)) return { kind: "foreign" };
  return { kind: "installed", current: body === HOOK_BODY };
}

export type InstallOutcome =
  | { kind: "installed"; path: string }
  | { kind: "updated"; path: string }
  | { kind: "unchanged"; path: string }
  | { kind: "occupied"; path: string }
  | { kind: "shared"; hooksPath: string }
  | { kind: "not-a-repo" };

/**
 * Write the hook.
 *
 * A hook lore did not write is left alone unless `force` says otherwise.
 * Chaining hooks is normal, and the file that is there may be the only thing
 * running git-lfs or a formatter for this repository.
 */
export function installHook(opts?: { cwd?: string; force?: boolean }): InstallOutcome {
  const target = resolveHooksTarget(opts?.cwd);
  if (target.kind === "not-a-repo") return { kind: "not-a-repo" };
  if (target.kind === "shared") return { kind: "shared", hooksPath: target.hooksPath };

  const state = readHookState(target.path);
  if (state.kind === "foreign" && !opts?.force) return { kind: "occupied", path: target.path };
  if (state.kind === "installed" && state.current) return { kind: "unchanged", path: target.path };

  mkdirSync(target.dir, { recursive: true });
  writeFileSync(target.path, HOOK_BODY, { mode: 0o755 });
  // writeFileSync keeps the mode of a file that already exists, so an earlier
  // hook without the execute bit would stay unexecutable and git would skip it.
  if ((statSync(target.path).mode & 0o111) === 0) {
    throw new Error(`Cannot make ${target.path} executable`);
  }
  return { kind: state.kind === "absent" ? "installed" : "updated", path: target.path };
}

export type UninstallOutcome =
  | { kind: "removed"; path: string }
  | { kind: "absent" }
  | { kind: "foreign"; path: string }
  | { kind: "shared"; hooksPath: string }
  | { kind: "not-a-repo" };

export function uninstallHook(opts?: { cwd?: string }): UninstallOutcome {
  const target = resolveHooksTarget(opts?.cwd);
  if (target.kind === "not-a-repo") return { kind: "not-a-repo" };
  if (target.kind === "shared") return { kind: "shared", hooksPath: target.hooksPath };

  const state = readHookState(target.path);
  if (state.kind === "absent") return { kind: "absent" };
  // Never remove a file lore did not write.
  if (state.kind === "foreign") return { kind: "foreign", path: target.path };
  rmSync(target.path);
  return { kind: "removed", path: target.path };
}

/** The line to add by hand, for a repository lore must not write to. */
export function manualHookLine(): string {
  return "lore ingest --queue >/dev/null 2>&1 || true";
}

export function describeHook(opts?: { cwd?: string }): string[] {
  const target = resolveHooksTarget(opts?.cwd);
  if (target.kind === "not-a-repo") return ["Not a git repository."];
  if (target.kind === "shared") {
    return [
      `core.hooksPath is ${target.hooksPath}, outside this repository.`,
      "git runs that directory for every repository that reads this config,",
      "so lore does not write there. Add this line to its post-commit hook:",
      `  ${manualHookLine()}`,
    ];
  }
  const state = readHookState(target.path);
  switch (state.kind) {
    case "absent":
      return [`No lore hook. Install it with \`lore sys hooks install\`.`, `  ${target.path}`];
    case "foreign":
      return [
        `A post-commit hook is already there, and lore did not write it.`,
        `  ${target.path}`,
        "Add this line to it, or pass --force to replace it:",
        `  ${manualHookLine()}`,
      ];
    case "installed":
      return state.current
        ? [`Installed.`, `  ${target.path}`]
        : [
            `Installed, and older than this lore.`,
            `  ${target.path}`,
            "Refresh it with `lore sys hooks install --force`.",
          ];
  }
}
