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
import { extractBindingsForConcepts } from "./binding-extraction.ts";
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
