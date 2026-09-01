import { test, expect, describe } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  describeHook,
  installHook,
  readHookState,
  resolveHooksTarget,
  uninstallHook,
} from "./hooks.ts";

// git reads the user's global and system config for every command, and a
// developer who sets core.hooksPath globally — git-lfs and husky both suggest
// it — would otherwise see these tests take the shared-directory path and
// fail. Point git at no config so the repository under test decides alone.
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "lore-hooks-"));
  spawnSync("git", ["init", "-q"], { cwd: dir, env: process.env });
  return dir;
}

describe("git hooks", () => {
  test("install writes an executable post-commit hook", () => {
    const repo = makeRepo();
    try {
      const result = installHook({ cwd: repo });
      expect(result.kind).toBe("installed");

      const path = join(repo, ".git", "hooks", "post-commit");
      const body = readFileSync(path, "utf-8");
      expect(body).toContain("lore ingest --queue");
      // git skips a hook it cannot execute, and skips it silently.
      expect(statSync(path).mode & 0o111).toBeGreaterThan(0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("the hook never fails or delays a commit", () => {
    const repo = makeRepo();
    try {
      installHook({ cwd: repo });
      const body = readFileSync(join(repo, ".git", "hooks", "post-commit"), "utf-8");
      // A missing lore, or a failing one, must leave the commit alone.
      expect(body).toContain("command -v lore >/dev/null 2>&1 || exit 0");
      expect(body).toContain("|| true");
      expect(body.trimEnd().endsWith("exit 0")).toBe(true);
      // The commit must not wait for a scan.
      expect(body).toContain("--queue");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("installing twice reports no change", () => {
    const repo = makeRepo();
    try {
      installHook({ cwd: repo });
      expect(installHook({ cwd: repo }).kind).toBe("unchanged");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a hook lore did not write is left alone", () => {
    const repo = makeRepo();
    try {
      const path = join(repo, ".git", "hooks", "post-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      writeFileSync(path, '#!/bin/sh\ngit lfs post-commit "$@"\n', { mode: 0o755 });

      // Chaining hooks is normal, and this one may be the only thing running
      // git-lfs for the repository.
      expect(installHook({ cwd: repo }).kind).toBe("occupied");
      expect(readFileSync(path, "utf-8")).toContain("git lfs");

      expect(installHook({ cwd: repo, force: true }).kind).toBe("updated");
      expect(readFileSync(path, "utf-8")).toContain("lore ingest");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("uninstall removes only a hook lore wrote", () => {
    const repo = makeRepo();
    try {
      const path = join(repo, ".git", "hooks", "post-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      writeFileSync(path, '#!/bin/sh\ngit lfs post-commit "$@"\n', { mode: 0o755 });

      expect(uninstallHook({ cwd: repo }).kind).toBe("foreign");
      expect(readFileSync(path, "utf-8")).toContain("git lfs");

      installHook({ cwd: repo, force: true });
      expect(uninstallHook({ cwd: repo }).kind).toBe("removed");
      expect(uninstallHook({ cwd: repo }).kind).toBe("absent");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a core.hooksPath outside the repository is refused, not written", () => {
    const repo = makeRepo();
    const shared = mkdtempSync(join(tmpdir(), "lore-shared-hooks-"));
    try {
      const existing = join(shared, "post-commit");
      writeFileSync(existing, '#!/bin/sh\ngit lfs post-commit "$@"\n', { mode: 0o755 });
      spawnSync("git", ["config", "core.hooksPath", shared], { cwd: repo, env: process.env });

      // This is the global hooks directory in most setups. git runs it for
      // every repository that reads the config, so writing there installs the
      // hook in all of them and overwrites what already serves them.
      const target = resolveHooksTarget(repo);
      expect(target.kind).toBe("shared");

      const result = installHook({ cwd: repo });
      expect(result.kind).toBe("shared");
      expect(readFileSync(existing, "utf-8")).toContain("git lfs");
      expect(readFileSync(existing, "utf-8")).not.toContain("lore");

      // --force must not defeat this: the file is not this repository's.
      expect(installHook({ cwd: repo, force: true }).kind).toBe("shared");
      expect(readFileSync(existing, "utf-8")).not.toContain("lore");

      expect(uninstallHook({ cwd: repo }).kind).toBe("shared");
      expect(describeHook({ cwd: repo }).join("\n")).toContain("lore ingest --queue");
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(shared, { recursive: true, force: true });
    }
  });

  test("a core.hooksPath inside the repository is used", () => {
    const repo = makeRepo();
    try {
      const inside = join(repo, ".githooks");
      mkdirSync(inside, { recursive: true });
      spawnSync("git", ["config", "core.hooksPath", ".githooks"], { cwd: repo, env: process.env });

      // A committed hooks directory belongs to this repository, so it is the
      // right place to write.
      expect(installHook({ cwd: repo }).kind).toBe("installed");
      expect(readFileSync(join(inside, "post-commit"), "utf-8")).toContain("lore ingest");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("outside a git repository nothing is written", () => {
    const dir = mkdtempSync(join(tmpdir(), "lore-not-repo-"));
    try {
      expect(resolveHooksTarget(dir).kind).toBe("not-a-repo");
      expect(installHook({ cwd: dir }).kind).toBe("not-a-repo");
      expect(uninstallHook({ cwd: dir }).kind).toBe("not-a-repo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a hook from an older lore is reported as out of date", () => {
    const repo = makeRepo();
    try {
      const path = join(repo, ".git", "hooks", "post-commit");
      mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
      // Carries the marker, so it is ours, but the body has moved on.
      writeFileSync(path, "#!/bin/sh\n# lore:post-commit\nlore ingest\n", { mode: 0o755 });

      const state = readHookState(path);
      expect(state).toEqual({ kind: "installed", current: false });
      expect(describeHook({ cwd: repo }).join("\n")).toContain("older than this lore");
      expect(installHook({ cwd: repo }).kind).toBe("updated");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
