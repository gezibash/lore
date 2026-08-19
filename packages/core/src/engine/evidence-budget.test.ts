import { expect, test } from "bun:test";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { scanProject } from "./scanner.ts";
import { budgetEvidenceContent } from "./narrative-lifecycle.ts";

/** Build a Python class whose discriminating method sits at the very end, after a long docstring. */
function classSource(): string {
  const docstring = Array.from({ length: 60 }, (_, i) => `    Example line ${i} of prose.`);
  return [
    "class URLPattern:",
    '    """',
    ...docstring,
    '    """',
    "",
    "    def matches(self, other):",
    "        return True",
    "",
    "    def __lt__(self, other):",
    "        return self.priority < other.priority",
    "",
  ].join("\n");
}

test("budgetEvidenceContent head-truncates prose but keeps whole source chunks", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(`${codeDir}/mod.py`, classSource());
    await scanProject(db, codeDir, loreDir);

    const prose = "x".repeat(5000);
    expect(budgetEvidenceContent(db, prose, 1600, 6000)).toHaveLength(1600);

    // A source chunk under the source budget survives intact — including its trailing method,
    // which the prose budget alone would have amputated.
    const source = `[Source: mod.py:1-71]\n\`\`\`python\n${classSource()}\n\`\`\``;
    expect(source.length).toBeGreaterThan(1600);
    const budgeted = budgetEvidenceContent(db, source, 1600, 6000);
    expect(budgeted).toBe(source);
    expect(budgeted).toContain("__lt__");
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("budgetEvidenceContent indexes the members it had to cut", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(`${codeDir}/mod.py`, classSource());
    await scanProject(db, codeDir, loreDir);

    const source = `[Source: mod.py:1-71]\n\`\`\`python\n${classSource()}\n\`\`\``;
    // Squeeze the source budget so the trailing methods fall outside the cut.
    const budgeted = budgetEvidenceContent(db, source, 200, 900);

    expect(budgeted).toContain("truncated");
    // The method body is gone, but the method is still named, located and citable.
    expect(budgeted).toContain("URLPattern.__lt__");
    expect(budgeted).toContain("mod.py:");
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});
