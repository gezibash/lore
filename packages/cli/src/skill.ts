/**
 * Agent skill lifecycle.
 *
 * The skill teaches an agent the lore workflow. It travels inside the release,
 * beside the binary, because a release install has no source checkout.
 *
 * `install` links by default. A link follows `lore upgrade` on its own, so the
 * skill never falls behind the binary that documents it. `--copy` writes a
 * detached copy for anyone who wants the file to stay still.
 */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

const SKILL_NAME = "lore";

/** Replaced at build time by scripts/build.ts. Absent when run from source. */
declare const LORE_BUILD_SHA: string | undefined;

/** Where Claude Code reads skills from. */
export function defaultSkillDir(): string {
  return join(homedir(), ".claude", "skills", SKILL_NAME);
}

/**
 * The skill this binary carries.
 *
 * A compiled binary keeps it in skills/ beside itself. A source run reads the
 * checkout, so an edit applies without a build.
 */
export function skillSource(execPath = process.execPath, moduleDir = import.meta.dir): string {
  if (typeof LORE_BUILD_SHA !== "undefined" && LORE_BUILD_SHA) {
    return join(dirname(execPath), "skills", SKILL_NAME);
  }
  // packages/cli/src -> repo root
  return resolve(moduleDir, "..", "..", "..", "skills", SKILL_NAME);
}

export type SkillState =
  | { kind: "absent" }
  | { kind: "linked"; target: string; current: boolean; dangling: boolean }
  | { kind: "copied"; stale: boolean }
  | { kind: "foreign" };

/** Read the first heading-free description line, used to compare two copies. */
function fingerprint(dir: string): string | null {
  try {
    return readFileSync(join(dir, "SKILL.md"), "utf-8");
  } catch {
    return null;
  }
}

/** What sits at `dir` right now. */
export function skillState(dir: string, source: string): SkillState {
  if (!existsSync(dir)) {
    // A dangling link exists without existsSync seeing it.
    try {
      lstatSync(dir);
    } catch {
      return { kind: "absent" };
    }
  }
  let stat;
  try {
    stat = lstatSync(dir);
  } catch {
    return { kind: "absent" };
  }

  if (stat.isSymbolicLink()) {
    const target = readlinkSync(dir);
    const dangling = !existsSync(target);
    let current = false;
    try {
      current = realpathSync(dir) === realpathSync(source);
    } catch {
      current = false;
    }
    return { kind: "linked", target, current, dangling };
  }

  if (!stat.isDirectory()) return { kind: "foreign" };

  const installed = fingerprint(dir);
  if (installed === null) return { kind: "foreign" };
  return { kind: "copied", stale: installed !== fingerprint(source) };
}

export type SkillResult = { ok: boolean; message: string };

export function installSkill(opts: {
  dir?: string;
  source?: string;
  copy?: boolean;
  force?: boolean;
}): SkillResult {
  const dir = opts.dir ?? defaultSkillDir();
  const source = opts.source ?? skillSource();

  if (!existsSync(join(source, "SKILL.md"))) {
    return { ok: false, message: `This build carries no skill at ${source}.` };
  }

  const state = skillState(dir, source);
  if (state.kind === "foreign" && !opts.force) {
    return {
      ok: false,
      message: `${dir} holds something else. Move it, or pass --force to replace it.`,
    };
  }
  if (state.kind === "copied" && !opts.copy && !opts.force) {
    return {
      ok: false,
      message: `${dir} is a copy, not a link. Pass --copy to refresh it, or --force to replace it with a link.`,
    };
  }

  mkdirSync(dirname(dir), { recursive: true });
  rmSync(dir, { recursive: true, force: true });

  if (opts.copy) {
    cpSync(source, dir, { recursive: true });
    return { ok: true, message: `Copied the skill to ${dir}` };
  }
  symlinkSync(source, dir);
  return { ok: true, message: `Linked ${dir} -> ${source}` };
}

export function uninstallSkill(opts: { dir?: string; source?: string }): SkillResult {
  const dir = opts.dir ?? defaultSkillDir();
  const source = opts.source ?? skillSource();
  const state = skillState(dir, source);

  if (state.kind === "absent") return { ok: true, message: "Nothing installed here." };
  if (state.kind === "foreign") {
    return { ok: false, message: `${dir} holds something else. Remove it by hand.` };
  }
  rmSync(dir, { recursive: true, force: true });
  return { ok: true, message: `Removed ${dir}` };
}

export function describeSkill(opts: { dir?: string; source?: string }): string[] {
  const dir = opts.dir ?? defaultSkillDir();
  const source = opts.source ?? skillSource();
  const state = skillState(dir, source);
  const lines = [`source   ${source}`, `target   ${dir}`];

  switch (state.kind) {
    case "absent":
      lines.push("status   not installed — run 'lore skill install'");
      break;
    case "linked":
      if (state.dangling) {
        lines.push(`status   linked to ${state.target}, which no longer exists`);
      } else {
        lines.push(
          state.current
            ? "status   linked, and it follows this lore"
            : `status   linked to ${state.target}, which is not this lore`,
        );
      }
      break;
    case "copied":
      lines.push(
        state.stale
          ? "status   copied, and it differs from this lore — run 'lore skill install --copy'"
          : "status   copied, and it matches this lore",
      );
      break;
    case "foreign":
      lines.push("status   something else sits here");
      break;
  }
  return lines;
}
