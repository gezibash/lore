import { expect, test } from "bun:test";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { rescanFiles, scanProject } from "./scanner.ts";
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

test("scanProject indexes .jsx with the javascript grammar", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    // .jsx maps to javascript, so it must not be handed the tsx grammar: the
    // javascript queries match nothing against a tsx tree and the file indexes
    // with no symbols at all.
    writeTextFile(
      `${codeDir}/src/widget.jsx`,
      [
        "export function Widget(props) { return <div>{props.x}</div>; }",
        "export class Panel { render() { return <span/>; } }",
        "const arrow = (a) => a + 1;",
        "",
      ].join("\n"),
    );

    const result = await scanProject(db, codeDir, loreDir);
    expect(result.files_failed).toBe(0);

    const stored = getSourceFileByPath(db, "src/widget.jsx");
    expect(stored?.language).toBe("javascript");

    const names = db
      .query<{ qualified_name: string }, []>("SELECT qualified_name FROM symbols")
      .all()
      .map((row) => row.qualified_name)
      .sort();
    // One row per definition: a const holding an arrow function matches both
    // the function pattern and the constant pattern, and must not be stored twice.
    expect(names).toEqual(["Panel", "Panel.render", "Widget", "arrow"]);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("rescanFiles refreshes an Elixir file instead of dropping it", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    // rescanFiles once carried its own extension map, which never learned about
    // Elixir. Every .ex file was skipped, and filesFailed did not say so, so the
    // stale symbols kept being served after a heal or a narrative close.
    writeTextFile(`${codeDir}/src/g.ex`, "defmodule G do\n  def a(x) do\n    x\n  end\nend\n");
    await scanProject(db, codeDir, loreDir);
    expect(getSourceFileByPath(db, "src/g.ex")?.symbol_count).toBe(2);

    writeTextFile(
      `${codeDir}/src/g.ex`,
      "defmodule G do\n  def a(x) do\n    x\n  end\n\n  def b(y) do\n    y\n  end\nend\n",
    );
    const result = await rescanFiles(db, codeDir, ["src/g.ex"], loreDir);

    expect(result.rescanned).toBe(1);
    expect(result.filesFailed).toEqual([]);
    expect(getSourceFileByPath(db, "src/g.ex")?.symbol_count).toBe(3);

    const names = db
      .query<{ qualified_name: string }, []>("SELECT qualified_name FROM symbols")
      .all()
      .map((row) => row.qualified_name)
      .sort();
    expect(names).toEqual(["G", "G.a", "G.b"]);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("rescanFiles reports files it dropped instead of silently skipping them", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(`${codeDir}/src/ok.ts`, "export function ok() { return 1; }\n");
    await scanProject(db, codeDir, loreDir);

    // Change the file so the rescan actually processes it (unchanged hashes skip).
    writeTextFile(`${codeDir}/src/ok.ts`, "export function ok() { return 2; }\n");
    const result = await rescanFiles(db, codeDir, ["src/ok.ts", "src/does-not-exist.ts"], loreDir);
    expect(result.rescanned).toBe(1);
    expect(result.filesFailed).toEqual(["src/does-not-exist.ts"]);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("a symbol's chunk absorbs the comment block documenting it", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const filePath = `${codeDir}/src/repair-shaped.ts`;

  try {
    // Shaped like packages/core/src/db/repair.ts:54-88, where the comment
    // explaining the allowlist was chunked away from the allowlist itself and
    // ask() then reported that no such list existed.
    writeTextFile(
      filePath,
      [
        "interface SchemaAudit {",
        "  pendingNames: string[];",
        "}",
        "",
        "// Pending migrations are only reconciled automatically when they are",
        "// explicitly marked as schema-only. This avoids silently stamping",
        "// future data backfills as applied based on DDL equivalence alone.",
        "const RECONCILABLE_MIGRATIONS = new Set([",
        '  "001_initial",',
        '  "002_concept_lifecycle",',
        "]);",
        "",
        "export function isReconcilable(name: string): boolean {",
        "  return RECONCILABLE_MIGRATIONS.has(name);",
        "}",
        "",
      ].join("\n"),
    );

    await scanProject(db, codeDir, loreDir);

    const chunkPaths = getSourceChunkPathsForFile(db, "src/repair-shaped.ts");
    expect(chunkPaths.length).toBeGreaterThan(0);
    const bodies = await Promise.all(chunkPaths.map((path) => Bun.file(path).text()));

    const withList = bodies.filter((body) => body.includes("RECONCILABLE_MIGRATIONS = new Set"));
    expect(withList.length).toBe(1);
    // The comment must travel with the declaration it documents.
    expect(withList[0]).toContain("explicitly marked as schema-only");

    // ...and must not be duplicated into a module gap chunk.
    const withComment = bodies.filter((body) => body.includes("explicitly marked as schema-only"));
    expect(withComment.length).toBe(1);

    // A blank line separates the interface from the comment, so the interface
    // keeps its own chunk rather than swallowing the block below it.
    const withInterface = bodies.filter((body) => body.includes("interface SchemaAudit"));
    expect(withInterface.length).toBe(1);
    expect(withInterface[0]).not.toContain("explicitly marked as schema-only");
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("scanProject --force replaces chunks and symbols instead of duplicating them", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const filePath = `${codeDir}/src/stable.ts`;

  try {
    writeTextFile(
      filePath,
      ["export function alpha() {", "  return 1;", "}", "", "const BETA = 2;", ""].join("\n"),
    );

    await scanProject(db, codeDir, loreDir);
    const firstChunks = getSourceChunkPathsForFile(db, "src/stable.ts").length;
    const countSymbols = () =>
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM symbols").get()?.n ?? 0;
    const firstSymbols = countSymbols();
    expect(firstChunks).toBeGreaterThan(0);
    expect(firstSymbols).toBeGreaterThan(0);

    // Same content, forced re-chunk: the file must be re-indexed, not indexed twice.
    await scanProject(db, codeDir, loreDir, { force: true });
    expect(getSourceChunkPathsForFile(db, "src/stable.ts").length).toBe(firstChunks);
    expect(countSymbols()).toBe(firstSymbols);

    await scanProject(db, codeDir, loreDir, { force: true });
    expect(getSourceChunkPathsForFile(db, "src/stable.ts").length).toBe(firstChunks);
    expect(countSymbols()).toBe(firstSymbols);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});
