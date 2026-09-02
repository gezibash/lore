import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTestDb } from "../../test/support/db.ts";
import { insertSymbol } from "@/db/symbols.ts";
import { upsertSourceFile } from "@/db/source-files.ts";
import { resolveEntrySymbols } from "./narrative-lifecycle.ts";

function addSymbol(db: Database, file: string, owner: string | null, name: string): string {
  const source = upsertSourceFile(db, {
    filePath: file,
    language: "typescript",
    contentHash: `hash-${file}-${name}`,
    sizeBytes: 100,
    symbolCount: 1,
  });
  return insertSymbol(db, {
    sourceFileId: source.id,
    name,
    qualifiedName: owner ? `${owner}.${name}` : name,
    kind: owner ? "method" : "function",
    parentId: null,
    lineStart: 42,
    lineEnd: 50,
    signature: null,
    bodyHash: `body-${file}-${name}`,
    exportStatus: "exported",
  }).id;
}

test("one match attaches", () => {
  const db = createTestDb();
  const id = addSymbol(db, "src/routing.ts", null, "routeConcept");

  const result = resolveEntrySymbols(db, ["routeConcept"]);

  expect(result.attached).toEqual([id]);
  expect(result.unattached).toEqual([]);
  db.close();
});

test("a short name that fits several symbols attaches to none and names the places", () => {
  const db = createTestDb();
  addSymbol(db, "src/engine.ts", "LoreEngine", "open");
  addSymbol(db, "src/worker.ts", "WorkerClient", "open");

  const result = resolveEntrySymbols(db, ["open"]);

  expect(result.attached).toEqual([]);
  expect(result.unattached).toEqual([
    {
      name: "open",
      reason: "ambiguous",
      places: ["src/engine.ts:42", "src/worker.ts:42"],
    },
  ]);
  db.close();
});

test("the qualified name picks one of those symbols", () => {
  const db = createTestDb();
  const wanted = addSymbol(db, "src/engine.ts", "LoreEngine", "open");
  addSymbol(db, "src/worker.ts", "WorkerClient", "open");

  const result = resolveEntrySymbols(db, ["LoreEngine.open"]);

  expect(result.attached).toEqual([wanted]);
  expect(result.unattached).toEqual([]);
  db.close();
});

test("a name no file declares attaches to nothing and says so", () => {
  const db = createTestDb();
  addSymbol(db, "src/routing.ts", null, "routeConcept");

  const result = resolveEntrySymbols(db, ["routeConcpet"]);

  expect(result.attached).toEqual([]);
  expect(result.unattached).toEqual([{ name: "routeConcpet", reason: "unknown" }]);
  db.close();
});

/** A typo used to reach FTS, which ranks candidates and returns its best row.
 *  That row became a binding at close, and nobody saw the substitution. */
test("a near miss does not fall back to a search hit", () => {
  const db = createTestDb();
  addSymbol(db, "src/routing.ts", null, "routeConcept");
  addSymbol(db, "src/routing.ts", null, "routeNarrative");

  expect(resolveEntrySymbols(db, ["route"]).attached).toEqual([]);
  expect(resolveEntrySymbols(db, ["routeConcepts"]).attached).toEqual([]);
  db.close();
});

test("the names that resolve still attach when a sibling does not", () => {
  const db = createTestDb();
  const good = addSymbol(db, "src/routing.ts", null, "routeConcept");
  addSymbol(db, "src/engine.ts", "LoreEngine", "open");
  addSymbol(db, "src/worker.ts", "WorkerClient", "open");

  const result = resolveEntrySymbols(db, ["routeConcept", "open", "missingThing"]);

  expect(result.attached).toEqual([good]);
  expect(result.unattached.map((sym) => sym.reason)).toEqual(["ambiguous", "unknown"]);
  db.close();
});

test("no names given is not an error", () => {
  const db = createTestDb();

  expect(resolveEntrySymbols(db, undefined)).toEqual({ attached: [], unattached: [] });
  expect(resolveEntrySymbols(db, [])).toEqual({ attached: [], unattached: [] });
  db.close();
});
