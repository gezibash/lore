import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { insertChunk } from "@/db/chunks.ts";
import { insertConcept } from "@/db/concepts.ts";
import {
  getBindingsForConcept,
  upsertConceptSymbol,
  upsertInferredConceptSymbol,
} from "@/db/concept-symbols.ts";
import { upsertSourceFile } from "@/db/source-files.ts";
import { insertSymbol } from "@/db/symbols.ts";
import { writeStateChunk } from "@/storage/index.ts";
import {
  autoBindByFileOverlap,
  extractBindingsForConcepts,
  findBindableSymbolsByName,
  isSymbolShapedName,
} from "./binding-extraction.ts";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";

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

/**
 * The binding refresh queued after a close wiped every binding for a concept
 * and rewrote the name matches as `mention`. An explicit `lore sys concept
 * bind` was downgraded, and `lore status` reported `ref: 4 → 0`.
 */
test("the binding refresh keeps an explicit ref binding", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-bind-");
  try {
    const concept = insertConcept(db, "posting-rules");
    const chunk = await writeStateChunk({
      lorePath,
      concept: "posting-rules",
      conceptId: concept.id,
      narrativeOrigin: "seed",
      version: 1,
      content: "transferPaths builds the movements. buildEvents writes them out.",
    });
    insertChunk(db, {
      id: chunk.id,
      filePath: chunk.filePath,
      flType: "chunk",
      conceptId: concept.id,
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    db.run("UPDATE concepts SET active_chunk_id = ? WHERE id = ?", [chunk.id, concept.id]);

    const stated = addSymbol(db, "transferPaths");
    const guessed = addSymbol(db, "buildEvents");
    upsertConceptSymbol(db, {
      conceptId: concept.id,
      symbolId: stated,
      bindingType: "ref",
      boundBodyHash: "body-at-bind-time",
      confidence: 1.0,
    });
    upsertInferredConceptSymbol(db, {
      conceptId: concept.id,
      symbolId: guessed,
      bindingType: "mention",
      boundBodyHash: "body-buildEvents",
      confidence: 0.5,
    });

    const result = await extractBindingsForConcepts(db, [concept.id]);

    const bindings = getBindingsForConcept(db, concept.id);
    const ref = bindings.find((binding) => binding.symbol_id === stated);
    expect(ref?.binding_type).toBe("ref");
    expect(ref?.confidence).toBe(1);
    expect(ref?.bound_body_hash).toBe("body-at-bind-time");
    expect(bindings).toHaveLength(2);
    // The result reports the bindings the concept holds after the pass.
    expect(result.byType.ref).toBe(1);
    expect(result.byType.mention).toBe(1);
    expect(result.bound).toBe(2);
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

/** Several symbols in one file, the shape of a barrel module. */
function addExportsIn(db: Database, filePath: string, names: string[]): string[] {
  const file = upsertSourceFile(db, {
    filePath,
    language: "typescript",
    contentHash: `hash-${filePath}`,
    sizeBytes: 400,
    symbolCount: names.length,
  });
  return names.map(
    (name, index) =>
      insertSymbol(db, {
        sourceFileId: file.id,
        name,
        qualifiedName: name,
        kind: "function",
        parentId: null,
        lineStart: (index + 1) * 10,
        lineEnd: (index + 1) * 10 + 4,
        signature: null,
        bodyHash: `body-${name}`,
        exportStatus: "exported",
      }).id,
  );
}

/**
 * This is why the close path does not call the sweep.
 *
 * One binding into a barrel module binds every export of it, whatever the
 * concept is about. In this repository `packages/sdk/src/index.ts` carries
 * about thirty exports, and two unrelated concepts each ended up holding the
 * same thirty — a set that describes neither of them.
 *
 * The function stays for `autoBindSemantic`, which falls back to it when no
 * code embedding model is configured, and for `heal`, which calls it only for
 * a concept that holds no bindings at all.
 */
test("the file-overlap sweep binds every export of a file it touches once", async () => {
  const db = createTestDb();
  const concept = insertConcept(db, "posting-rules");
  const [seed] = addExportsIn(db, "src/barrel.ts", [
    "transferPaths",
    "formatOpen",
    "formatClose",
    "KpiGoalOptions",
  ]);
  upsertConceptSymbol(db, {
    conceptId: concept.id,
    symbolId: seed!,
    bindingType: "ref",
    boundBodyHash: "body-transferPaths",
    confidence: 0.5,
  });

  await autoBindByFileOverlap(db, { conceptIds: [concept.id] });

  // One seed binding drew in all three siblings, none of which the concept
  // names. The seed itself keeps the confidence it was given.
  const bound = getBindingsForConcept(db, concept.id);
  expect(bound).toHaveLength(4);
  expect(bound.filter((b) => b.confidence === 0.8)).toHaveLength(3);
  db.close();
});

test("an all-lowercase word is prose, not a symbol reference", () => {
  // Every one of these names a symbol in this repository, and every one is a
  // word ordinary prose about narratives and concepts contains.
  for (const word of ["from", "name", "open", "note", "call", "clear", "concept", "search"]) {
    expect(isSymbolShapedName(word)).toBe(false);
  }
});

test("a name a writer could only have meant as a symbol is kept", () => {
  for (const name of [
    "routeConcept",
    "LoreEngine",
    "INBOX_NARRATIVE",
    "getOpenNarratives",
    "Embedder",
    "snake_case_name",
    "parse2",
  ]) {
    expect(isSymbolShapedName(name)).toBe(true);
  }
});

test("a name under three characters is never evidence", () => {
  expect(isSymbolShapedName("id")).toBe(false);
  expect(isSymbolShapedName("Db")).toBe(false);
});

test("a lowercase word in any script is prose", () => {
  // An ASCII-only test kept these as symbol-shaped evidence.
  for (const word of ["café", "über", "naïve"]) {
    expect(isSymbolShapedName(word)).toBe(false);
  }
});

test("a name of punctuation is not a symbol reference", () => {
  // `\b___\b` matches a markdown horizontal rule in concept prose.
  expect(isSymbolShapedName("___")).toBe(false);
  expect(isSymbolShapedName("---")).toBe(false);
  expect(isSymbolShapedName("_id_")).toBe(true);
});

/** Binding refuses a test file, so a test twin must not veto the source symbol. */
test("a test-file twin does not make the source symbol ambiguous", () => {
  const db = createTestDb();
  const source = upsertSourceFile(db, {
    filePath: "src/routing.ts",
    language: "typescript",
    contentHash: "h-src",
    sizeBytes: 100,
    symbolCount: 1,
  });
  const test = upsertSourceFile(db, {
    filePath: "src/routing.test.ts",
    language: "typescript",
    contentHash: "h-test",
    sizeBytes: 100,
    symbolCount: 1,
  });
  const wanted = insertSymbol(db, {
    sourceFileId: source.id,
    name: "routeConcept",
    qualifiedName: "routeConcept",
    kind: "function",
    parentId: null,
    lineStart: 4,
    lineEnd: 9,
    signature: null,
    bodyHash: "b-src",
    exportStatus: "exported",
  }).id;
  insertSymbol(db, {
    sourceFileId: test.id,
    name: "routeConcept",
    qualifiedName: "routeConcept",
    kind: "function",
    parentId: null,
    lineStart: 12,
    lineEnd: 14,
    signature: null,
    bodyHash: "b-test",
    exportStatus: "exported",
  });

  const found = findBindableSymbolsByName(db, "routeConcept");

  expect(found.map((s) => s.id)).toEqual([wanted]);
  db.close();
});

test("a name only a test file declares still resolves", () => {
  const db = createTestDb();
  const file = upsertSourceFile(db, {
    filePath: "src/only.test.ts",
    language: "typescript",
    contentHash: "h-only",
    sizeBytes: 100,
    symbolCount: 1,
  });
  insertSymbol(db, {
    sourceFileId: file.id,
    name: "addSymbol",
    qualifiedName: "addSymbol",
    kind: "function",
    parentId: null,
    lineStart: 3,
    lineEnd: 8,
    signature: null,
    bodyHash: "b-only",
    exportStatus: "exported",
  });

  // Refusing outright would report "no symbol" for one the index holds.
  expect(findBindableSymbolsByName(db, "addSymbol")).toHaveLength(1);
  db.close();
});
