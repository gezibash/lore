import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describeSkill, installSkill, skillSource, skillState, uninstallSkill } from "./skill.ts";

function makeSource(body = "# Lore\n"): string {
  const dir = mkdtempSync(join(tmpdir(), "lore-skill-src-"));
  mkdirSync(join(dir, "references"), { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
  writeFileSync(join(dir, "references", "loop.md"), "loop\n");
  return dir;
}

function target(): string {
  return join(mkdtempSync(join(tmpdir(), "lore-skill-dst-")), "lore");
}

test("install links the skill, and status says it follows this lore", () => {
  const source = makeSource();
  const dir = target();
  try {
    const result = installSkill({ dir, source });
    expect(result.ok).toBe(true);
    const state = skillState(dir, source);
    expect(state.kind).toBe("linked");
    expect(state.kind === "linked" && state.current).toBe(true);
    expect(describeSkill({ dir, source }).join("\n")).toContain("follows this lore");
    // The link resolves to the real files.
    expect(readFileSync(join(dir, "references", "loop.md"), "utf-8")).toBe("loop\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("install --copy writes real files, and detects a later drift", () => {
  const source = makeSource("# Lore v1\n");
  const dir = target();
  try {
    expect(installSkill({ dir, source, copy: true }).ok).toBe(true);
    expect(skillState(dir, source)).toEqual({ kind: "copied", stale: false });

    // The source moves on; the copy does not.
    writeFileSync(join(source, "SKILL.md"), "# Lore v2\n");
    expect(skillState(dir, source)).toEqual({ kind: "copied", stale: true });
    expect(describeSkill({ dir, source }).join("\n")).toContain("differs from this lore");

    expect(installSkill({ dir, source, copy: true }).ok).toBe(true);
    expect(skillState(dir, source)).toEqual({ kind: "copied", stale: false });
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("install refuses to replace a copy with a link without a flag", () => {
  const source = makeSource();
  const dir = target();
  try {
    installSkill({ dir, source, copy: true });
    const result = installSkill({ dir, source });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("--copy");
    // The copy survives the refusal.
    expect(skillState(dir, source).kind).toBe("copied");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("install refuses to replace something it does not recognise", () => {
  const source = makeSource();
  const dir = target();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.md"), "someone else's skill\n");
    expect(skillState(dir, source).kind).toBe("foreign");

    const refused = installSkill({ dir, source });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("--force");
    expect(readFileSync(join(dir, "other.md"), "utf-8")).toContain("someone else");

    expect(installSkill({ dir, source, force: true }).ok).toBe(true);
    expect(skillState(dir, source).kind).toBe("linked");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("a link to another lore reads as not current", () => {
  const source = makeSource();
  const other = makeSource("# Another\n");
  const dir = target();
  try {
    symlinkSync(other, dir);
    const state = skillState(dir, source);
    expect(state.kind).toBe("linked");
    expect(state.kind === "linked" && state.current).toBe(false);
    expect(describeSkill({ dir, source }).join("\n")).toContain("not this lore");
  } finally {
    rmSync(source, { recursive: true, force: true });
    rmSync(other, { recursive: true, force: true });
  }
});

test("a link whose target is gone reads as dangling", () => {
  const source = makeSource();
  const dir = target();
  try {
    installSkill({ dir, source });
    rmSync(source, { recursive: true, force: true });
    const state = skillState(dir, source);
    expect(state.kind).toBe("linked");
    expect(state.kind === "linked" && state.dangling).toBe(true);
    expect(describeSkill({ dir, source }).join("\n")).toContain("no longer exists");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("a relative link that resolves is not dangling", () => {
  // ~/.claude/skills/lore -> ../../.agents/skills/lore is a real layout.
  const root = mkdtempSync(join(tmpdir(), "lore-skill-rel-"));
  const source = join(root, "agents", "skills", "lore");
  mkdirSync(join(source, "references"), { recursive: true });
  writeFileSync(join(source, "SKILL.md"), "# Lore\n");
  const holder = join(root, "claude", "skills");
  mkdirSync(holder, { recursive: true });
  const dir = join(holder, "lore");
  try {
    symlinkSync("../../agents/skills/lore", dir);
    const state = skillState(dir, source);
    expect(state.kind).toBe("linked");
    expect(state.kind === "linked" && state.dangling).toBe(false);
    expect(state.kind === "linked" && state.current).toBe(true);
    expect(describeSkill({ dir, source }).join("\n")).not.toContain("no longer exists");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("uninstall removes a link and is safe to repeat", () => {
  const source = makeSource();
  const dir = target();
  try {
    installSkill({ dir, source });
    expect(uninstallSkill({ dir, source }).ok).toBe(true);
    expect(skillState(dir, source).kind).toBe("absent");
    const again = uninstallSkill({ dir, source });
    expect(again.ok).toBe(true);
    expect(again.message).toContain("Nothing installed");
    // Removing the link leaves the source alone.
    expect(readFileSync(join(source, "SKILL.md"), "utf-8")).toBe("# Lore\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("uninstall will not remove something it does not recognise", () => {
  const source = makeSource();
  const dir = target();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "other.md"), "keep me\n");
    const result = uninstallSkill({ dir, source });
    expect(result.ok).toBe(false);
    expect(readFileSync(join(dir, "other.md"), "utf-8")).toBe("keep me\n");
  } finally {
    rmSync(source, { recursive: true, force: true });
  }
});

test("install reports a build that carries no skill", () => {
  const dir = target();
  const empty = mkdtempSync(join(tmpdir(), "lore-skill-empty-"));
  try {
    const result = installSkill({ dir, source: empty });
    expect(result.ok).toBe(false);
    expect(result.message).toContain("carries no skill");
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});

test("the shipped skill has frontmatter every agent can parse", () => {
  // `npx skills` and the other agents parse this block with a strict YAML
  // reader. An unquoted value holding ": " reads as a nested mapping and the
  // whole skill is skipped, which is how this broke once.
  const text = readFileSync(join(skillSource(), "SKILL.md"), "utf-8");
  expect(text.startsWith("---\n")).toBe(true);

  const end = text.indexOf("\n---", 3);
  expect(end).toBeGreaterThan(0);

  const front = Bun.YAML.parse(text.slice(4, end)) as Record<string, unknown>;
  expect(typeof front.name).toBe("string");
  expect(typeof front.description).toBe("string");
  expect(front.name).toBe("lore");
  expect((front.description as string).length).toBeGreaterThan(20);
});
