import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import { pruneOrphanedBindings, upsertConceptSymbol, getBindingCounts } from "./concept-symbols.ts";
import { insertConcept } from "./concepts.ts";
import { insertSymbol } from "./symbols.ts";
import { upsertSourceFile } from "./source-files.ts";

function addSymbol(db: Database, name: string): string {
  const file = upsertSourceFile(db, {
    filePath: `src/${name}.ts`,
    language: "typescript",
    contentHash: `hash-${name}`,
    sizeBytes: 100,
    symbolCount: 1,
  });
  return insertSymbol(db, {
    sourceFileId: file.id,
    name,
    qualifiedName: name,
    kind: "function",
    parentId: null,
    lineStart: 1,
    lineEnd: 5,
    signature: null,
    bodyHash: `body-${name}`,
    exportStatus: "exported",
  }).id;
}

function bind(db: Database, conceptId: string, symbolId: string): void {
  upsertConceptSymbol(db, {
    conceptId,
    symbolId,
    bindingType: "mention",
    boundBodyHash: null,
    confidence: 0.8,
  });
}

test("pruneOrphanedBindings drops bindings whose symbol or concept is gone", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "Live concept");
  const live = addSymbol(db, "live");
  const dead = addSymbol(db, "dead");

  bind(db, concept.id, live);
  bind(db, concept.id, dead);
  bind(db, "concept-that-never-existed", live);

  db.run(`DELETE FROM symbols WHERE id = ?`, [dead]);
  expect(getBindingCounts(db).total).toBe(3);

  expect(pruneOrphanedBindings(db)).toBe(2);
  expect(getBindingCounts(db).total).toBe(1);

  db.close();
});

test("a NULL symbol id does not stop the sweep", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "Live concept");
  const live = addSymbol(db, "live");
  const dead = addSymbol(db, "dead");
  bind(db, concept.id, live);
  bind(db, concept.id, dead);
  db.run(`DELETE FROM symbols WHERE id = ?`, [dead]);

  // symbols.id is a TEXT PRIMARY KEY with no NOT NULL, so SQLite accepts one.
  // Under NOT IN, a single such row makes the whole sweep match nothing.
  // concepts.id carries NOT NULL, so only this side can happen.
  const file = upsertSourceFile(db, {
    filePath: "src/null.ts",
    language: "typescript",
    contentHash: "hash-null",
    sizeBytes: 10,
    symbolCount: 0,
  });
  db.run(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, scanned_at)
     VALUES (NULL, ?, 'null-id', 'null-id', 'function', 1, 2, '2024-01-01T00:00:00.000Z')`,
    [file.id],
  );

  expect(pruneOrphanedBindings(db)).toBe(1);
  expect(getBindingCounts(db).total).toBe(1);

  db.close();
});
