import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import {
  deleteInferredBindingsForConcept,
  getBindingCounts,
  getBindingsForConcept,
  getExplicitBindingSymbolIds,
  findBoundSymbolsByName,
  pruneOrphanedBindings,
  upsertConceptSymbol,
  upsertInferredConceptSymbol,
} from "./concept-symbols.ts";
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

/**
 * `lore sys concept bind` writes a `ref` binding: the operator stated it.
 * The binding refresh that runs after a close used to wipe every binding and
 * rewrite the matches as `mention`, so `lore status` reported `ref: 4 → 0` and
 * read as data loss.
 */
function bindRef(db: Database, conceptId: string, symbolId: string): void {
  upsertConceptSymbol(db, {
    conceptId,
    symbolId,
    bindingType: "ref",
    boundBodyHash: "body-at-bind-time",
    confidence: 1.0,
  });
}

test("an inferred upsert leaves an explicit ref binding alone", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "posting-rules");
  const symbol = addSymbol(db, "transferPaths");
  bindRef(db, concept.id, symbol);

  upsertInferredConceptSymbol(db, {
    conceptId: concept.id,
    symbolId: symbol,
    bindingType: "mention",
    boundBodyHash: "body-now",
    confidence: 0.6,
  });

  const [binding] = getBindingsForConcept(db, concept.id);
  expect(binding?.binding_type).toBe("ref");
  expect(binding?.confidence).toBe(1);
  // The hash drift is measured against must survive too.
  expect(binding?.bound_body_hash).toBe("body-at-bind-time");
  db.close();
});

test("an inferred upsert still refreshes an inferred binding", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "posting-rules");
  const symbol = addSymbol(db, "transferPaths");
  bind(db, concept.id, symbol);

  upsertInferredConceptSymbol(db, {
    conceptId: concept.id,
    symbolId: symbol,
    bindingType: "mention",
    boundBodyHash: "body-now",
    confidence: 0.5,
  });

  const [binding] = getBindingsForConcept(db, concept.id);
  expect(binding?.confidence).toBe(0.5);
  expect(binding?.bound_body_hash).toBe("body-now");
  db.close();
});

test("the inferred delete keeps the explicit bindings", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "posting-rules");
  const stated = addSymbol(db, "transferPaths");
  const guessed = addSymbol(db, "buildEvents");
  bindRef(db, concept.id, stated);
  bind(db, concept.id, guessed);

  deleteInferredBindingsForConcept(db, concept.id);

  expect(getBindingCounts(db)).toMatchObject({ ref: 1, mention: 0 });
  expect([...getExplicitBindingSymbolIds(db, concept.id)]).toEqual([stated]);
  db.close();
});

/** Two files declare `open`, and the concept binds the one in worker.ts. A
 *  lookup over every symbol of that name can return the other. */
function addSymbolIn(db: Database, file: string, name: string): string {
  const source = upsertSourceFile(db, {
    filePath: file,
    language: "typescript",
    contentHash: `hash-${file}`,
    sizeBytes: 100,
    symbolCount: 1,
  });
  return insertSymbol(db, {
    sourceFileId: source.id,
    name,
    qualifiedName: name,
    kind: "function",
    parentId: null,
    lineStart: 7,
    lineEnd: 9,
    signature: null,
    bodyHash: `body-${file}-${name}`,
    exportStatus: "exported",
  }).id;
}

test("findBoundSymbolsByName reads only the bindings of that concept", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "cli-surface");
  const bound = addSymbolIn(db, "src/worker.ts", "open");
  const unbound = addSymbolIn(db, "src/engine.ts", "open");
  bind(db, concept.id, bound);

  const matches = findBoundSymbolsByName(db, concept.id, "open");

  expect(matches).toHaveLength(1);
  expect(matches[0]?.symbol_id).toBe(bound);
  expect(matches[0]?.file_path).toBe("src/worker.ts");
  expect(matches.some((m) => m.symbol_id === unbound)).toBe(false);
  db.close();
});

test("findBoundSymbolsByName returns every file when one concept binds both", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "cli-surface");
  bind(db, concept.id, addSymbolIn(db, "src/worker.ts", "open"));
  bind(db, concept.id, addSymbolIn(db, "src/engine.ts", "open"));

  const matches = findBoundSymbolsByName(db, concept.id, "open");

  expect(matches.map((m) => m.file_path)).toEqual(["src/engine.ts", "src/worker.ts"]);
  db.close();
});

test("findBoundSymbolsByName finds nothing for a name the concept never bound", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "cli-surface");
  addSymbolIn(db, "src/engine.ts", "open");

  expect(findBoundSymbolsByName(db, concept.id, "open")).toHaveLength(0);
  db.close();
});
