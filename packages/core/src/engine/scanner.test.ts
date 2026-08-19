import { expect, test } from "bun:test";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { scanProject } from "./scanner.ts";
import { getSourceFileByPath } from "@/db/source-files.ts";
import { getSourceChunkPathsForFile } from "@/db/chunks.ts";
import { upsertConceptSymbol } from "@/db/concept-symbols.ts";

test("scanProject preserves existing source state when replacement source chunks cannot be staged", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const badLoreRoot = `${createTempDir("lore-bad-")}/not-a-directory`;
  const filePath = `${codeDir}/src/example.ts`;

  try {
    writeTextFile(filePath, "export function example() { return 1; }\n");
    const first = await scanProject(db, codeDir, loreDir);
    expect(first.files_failed).toBe(0);

    const existing = getSourceFileByPath(db, "src/example.ts");
    expect(existing).not.toBeNull();
    const oldSourceChunks = getSourceChunkPathsForFile(db, "src/example.ts");
    expect(oldSourceChunks.length).toBeGreaterThan(0);

    writeTextFile(badLoreRoot, "blocked");
    writeTextFile(filePath, "export function example() { return 2; }\n");

    const failed = await scanProject(db, codeDir, badLoreRoot);
    expect(failed.files_failed).toBe(1);

    const after = getSourceFileByPath(db, "src/example.ts");
    expect(after).not.toBeNull();
    expect(after?.content_hash).toBe(existing?.content_hash);
    expect(getSourceChunkPathsForFile(db, "src/example.ts")).toEqual(oldSourceChunks);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
    removeDir(badLoreRoot.split("/not-a-directory")[0]!);
  }
});

test("scanProject qualifies Python methods with their class and links parent_id", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(
      `${codeDir}/mod.py`,
      [
        "def free_function():",
        "    return 1",
        "",
        "class URLPattern:",
        "    def __init__(self, pattern):",
        "        self.pattern = pattern",
        "",
        "    def __lt__(self, other):",
        "        return self.priority < other.priority",
        "",
        "class Other:",
        "    def __init__(self):",
        "        pass",
        "",
      ].join("\n"),
    );

    const result = await scanProject(db, codeDir, loreDir);
    expect(result.files_failed).toBe(0);

    const rows = db
      .query<{ name: string; qualified_name: string; kind: string; parent_id: string | null }, []>(
        "SELECT name, qualified_name, kind, parent_id FROM symbols",
      )
      .all();
    const byQualified = new Map(rows.map((r) => [r.qualified_name, r]));

    // Methods carry their class; top-level functions do not.
    expect(byQualified.has("URLPattern.__lt__")).toBe(true);
    expect(byQualified.has("free_function")).toBe(true);
    expect(byQualified.has("__lt__")).toBe(false);

    // Same-named methods on different classes stay distinguishable.
    expect(byQualified.has("URLPattern.__init__")).toBe(true);
    expect(byQualified.has("Other.__init__")).toBe(true);

    // parent_id points at the enclosing class row.
    const classId = db
      .query<{ id: string }, [string]>("SELECT id FROM symbols WHERE qualified_name = ?")
      .get("URLPattern")!.id;
    expect(byQualified.get("URLPattern")!.kind).toBe("class");
    expect(byQualified.get("URLPattern.__lt__")!.parent_id).toBe(classId);
    expect(byQualified.get("URLPattern.__init__")!.parent_id).toBe(classId);
    expect(byQualified.get("free_function")!.parent_id).toBeNull();
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("scanProject keeps symbol bindings when a rescan re-qualifies the symbol", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const filePath = `${codeDir}/mod.py`;
  const body = [
    "class URLPattern:",
    "    def __lt__(self, other):",
    "        return self.priority < other.priority",
    "",
  ].join("\n");

  try {
    writeTextFile(filePath, body);
    await scanProject(db, codeDir, loreDir);

    // Simulate a pre-fix database: the method was stored unqualified, as a bare `__lt__`.
    db.run("UPDATE symbols SET qualified_name = name WHERE name = '__lt__'");
    const symbolId = db
      .query<{ id: string }, []>("SELECT id FROM symbols WHERE name = '__lt__'")
      .get()!.id;
    db.run(
      "INSERT INTO concepts (version_id, id, name, inserted_at) VALUES (1, 'c1', 'proxy-routing', '2026-01-01T00:00:00Z')",
    );
    upsertConceptSymbol(db, {
      conceptId: "c1",
      symbolId,
      bindingType: "ref",
      boundBodyHash: null,
      boundBody: null,
      confidence: 0.9,
    });

    // Rescan with the qualifying scanner. A trailing comment forces the update path
    // without shifting any existing line numbers.
    writeTextFile(filePath, `${body}# touched\n`);
    await scanProject(db, codeDir, loreDir);

    const rebound = db
      .query<{ qualified_name: string }, []>(
        `SELECT s.qualified_name FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         WHERE cs.concept_id = 'c1'`,
      )
      .all();
    expect(rebound.map((r) => r.qualified_name)).toEqual(["URLPattern.__lt__"]);

    // The rescan must not leave binding rows pointing at the deleted symbol ids.
    const orphans = db
      .query<{ n: number }, []>(
        `SELECT count(*) AS n FROM concept_symbols cs
         LEFT JOIN symbols s ON cs.symbol_id = s.id
         WHERE s.id IS NULL`,
      )
      .get()!.n;
    expect(orphans).toBe(0);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});
