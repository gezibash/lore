import { expect, test, describe } from "bun:test";
import { insertConcept, insertConceptVersion } from "@/db/index.ts";
import { createTestDb } from "../../test/support/db.ts";
import {
  filterChunkIdsByScope,
  filterItemsByScope,
  isUnderScope,
  normalizeScope,
} from "./scope.ts";

describe("scope paths", () => {
  test("a scope matches itself and anything under it", () => {
    expect(isUnderScope("packages/core/src/a.ts", "packages/core")).toBe(true);
    expect(isUnderScope("packages/core", "packages/core")).toBe(true);
    expect(isUnderScope("packages/cli/src/a.ts", "packages/core")).toBe(false);
  });

  test("a sibling whose name starts with the scope is not under it", () => {
    // A plain prefix test takes this, and the scope then answers about a
    // package the reader did not ask about.
    expect(isUnderScope("packages/core-utils/src/a.ts", "packages/core")).toBe(false);
  });

  test("the same directory written differently is the same scope", () => {
    expect(normalizeScope("./packages/core/")).toBe("packages/core");
    expect(normalizeScope("packages/core")).toBe("packages/core");
  });
});

/** Insert a chunk row directly: the filter reads the table, not the lake. */
function addChunk(
  db: ReturnType<typeof createTestDb>,
  id: string,
  fields: { sourceFilePath?: string | null; conceptId?: string | null; flType?: string },
): void {
  db.query(
    `INSERT INTO chunks (id, file_path, fl_type, concept_id, narrative_id, supersedes_id,
       status, topics, convergence, theta, magnitude, created_at, source_file_path)
     VALUES (?, ?, ?, ?, NULL, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?)`,
  ).run(
    id,
    `/tmp/${id}.md`,
    fields.flType ?? (fields.sourceFilePath ? "source" : "chunk"),
    fields.conceptId ?? null,
    new Date().toISOString(),
    fields.sourceFilePath ?? null,
  );
}

function bind(
  db: ReturnType<typeof createTestDb>,
  conceptId: string,
  filePath: string,
  seq: string,
): void {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO source_files (id, file_path, language, content_hash, size_bytes, symbol_count, scanned_at)
     VALUES (?, ?, 'typescript', 'h', 1, 1, ?)`,
  ).run(`sf-${seq}`, filePath, now);
  db.query(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, scanned_at)
     VALUES (?, ?, 'x', 'x', 'function', 1, 2, ?)`,
  ).run(`sym-${seq}`, `sf-${seq}`, now);
  db.query(
    `INSERT INTO concept_symbols (id, concept_id, symbol_id, binding_type, confidence, created_at, updated_at)
     VALUES (?, ?, ?, 'ref', 1.0, ?, ?)`,
  ).run(`cs-${seq}`, conceptId, `sym-${seq}`, now, now);
}

describe("filterChunkIdsByScope", () => {
  test("a source chunk is judged by its own path", () => {
    const db = createTestDb();
    addChunk(db, "in", { sourceFilePath: "packages/core/src/a.ts" });
    addChunk(db, "out", { sourceFilePath: "packages/cli/src/b.ts" });

    const kept = filterChunkIdsByScope(db, ["in", "out"], ["packages/core"]);
    expect([...kept]).toEqual(["in"]);

    db.close();
  });

  test("a concept chunk is judged by where its bindings point", () => {
    const db = createTestDb();
    const inside = insertConcept(db, "core-thing");
    const outside = insertConcept(db, "cli-thing");
    bind(db, inside.id, "packages/core/src/a.ts", "1");
    bind(db, outside.id, "packages/cli/src/b.ts", "2");
    addChunk(db, "c-in", { conceptId: inside.id });
    addChunk(db, "c-out", { conceptId: outside.id });

    // Concept prose carries no path of its own — it is about the codebase, not
    // a piece of it — so the bindings are what place it.
    const kept = filterChunkIdsByScope(db, ["c-in", "c-out"], ["packages/core"]);
    expect([...kept]).toEqual(["c-in"]);

    db.close();
  });

  test("an archived unbound concept does not survive a scope", () => {
    const db = createTestDb();
    const retired = insertConcept(db, "old-architecture");
    insertConceptVersion(db, retired.id, {
      lifecycle_status: "archived",
      archived_at: new Date().toISOString(),
    });
    addChunk(db, "c-dead", { conceptId: retired.id });

    // Nothing places it, but it is no longer active. Keeping it would let a
    // retired concept answer a scoped question about living code.
    expect([...filterChunkIdsByScope(db, ["c-dead"], ["packages/core"])]).toEqual([]);

    db.close();
  });

  test("a concept with no bindings survives every scope", () => {
    const db = createTestDb();
    const floating = insertConcept(db, "architecture");
    addChunk(db, "c-free", { conceptId: floating.id });

    // Nothing places it, so nothing proves it is outside. Dropping it would
    // hide a purely architectural concept from every scoped question, and the
    // reader cannot see a concept that never arrived.
    const kept = filterChunkIdsByScope(db, ["c-free"], ["packages/core"]);
    expect([...kept]).toEqual(["c-free"]);

    db.close();
  });

  test("a concept bound both inside and outside is kept", () => {
    const db = createTestDb();
    const spanning = insertConcept(db, "shared-thing");
    bind(db, spanning.id, "packages/core/src/a.ts", "1");
    bind(db, spanning.id, "packages/cli/src/b.ts", "2");
    addChunk(db, "c-span", { conceptId: spanning.id });

    expect([...filterChunkIdsByScope(db, ["c-span"], ["packages/core"])]).toEqual(["c-span"]);

    db.close();
  });

  test("several scopes are a union", () => {
    const db = createTestDb();
    addChunk(db, "core", { sourceFilePath: "packages/core/src/a.ts" });
    addChunk(db, "cli", { sourceFilePath: "packages/cli/src/b.ts" });
    addChunk(db, "sdk", { sourceFilePath: "packages/sdk/src/c.ts" });

    const kept = filterChunkIdsByScope(
      db,
      ["core", "cli", "sdk"],
      ["packages/core", "packages/cli"],
    );
    expect([...kept].sort()).toEqual(["cli", "core"]);

    db.close();
  });

  test("a journal entry is not a place, so a scope leaves it alone", () => {
    const db = createTestDb();
    addChunk(db, "j", { flType: "journal", conceptId: null });

    // A journal entry belongs to a session, not to a directory.
    expect([...filterChunkIdsByScope(db, ["j"], ["packages/core"])]).toEqual(["j"]);

    db.close();
  });

  test("filterItemsByScope keeps only paths under the scope", () => {
    const items = [
      { file_path: "packages/core/src/a.ts", name: "in" },
      { file_path: "packages/cli/src/b.ts", name: "out" },
      { file_path: "packages/core-utils/src/c.ts", name: "sibling" },
    ];
    expect(filterItemsByScope(items, ["packages/core"]).map((item) => item.name)).toEqual(["in"]);
    expect(filterItemsByScope(items, []).map((item) => item.name)).toEqual([
      "in",
      "out",
      "sibling",
    ]);
  });

  test("no scope keeps everything", () => {
    const db = createTestDb();
    addChunk(db, "a", { sourceFilePath: "packages/cli/src/b.ts" });
    expect([...filterChunkIdsByScope(db, ["a"], [])]).toEqual(["a"]);
    db.close();
  });
});
