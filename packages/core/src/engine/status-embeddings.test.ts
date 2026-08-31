import { expect, test } from "bun:test";
import { join } from "path";
import { LoreEngine } from "./index.ts";
import { openDb } from "@/db/connection.ts";
import { insertSymbolEmbedding } from "@/db/embeddings.ts";
import { insertSymbol } from "@/db/symbols.ts";
import { upsertSourceFile } from "@/db/source-files.ts";
import { writeLocalConfig } from "@/config/index.ts";
import { createTempDir, createTestLoreRoot, removeDir } from "../../test/support/db.ts";
import type { Database } from "bun:sqlite";

function addSymbol(db: Database, name: string): string {
  const sourceFileId = upsertSourceFile(db, {
    filePath: `src/${name}.ts`,
    language: "typescript",
    contentHash: `hash-${name}`,
    sizeBytes: 100,
    symbolCount: 1,
  }).id;
  return insertSymbol(db, {
    sourceFileId,
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

async function mindWithSymbolLane(
  name: string,
  seed: (db: Database) => void,
  codeModel?: string,
): Promise<{ engine: LoreEngine; codePath: string; loreRoot: string }> {
  const loreRoot = createTestLoreRoot();
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });
  const registered = await engine.register(codePath, name);
  if (codeModel) {
    writeLocalConfig(codePath, { ai: { embedding: { code: { model: codeModel } } } });
  }
  const db = openDb(join(registered.lore_path, "lore.db"));
  try {
    seed(db);
  } finally {
    db.close();
  }
  return { engine, codePath, loreRoot };
}

test("status reports the symbol lane the code model cannot read", async () => {
  const { engine, codePath, loreRoot } = await mindWithSymbolLane(
    "symbol-lane-stale",
    (db) => {
      insertSymbolEmbedding(db, addSymbol(db, "stale"), new Float32Array([0.1]), "code-old");
      // Holds both models, so every reader finds it. It must not count as stale.
      const both = addSymbol(db, "both");
      insertSymbolEmbedding(db, both, new Float32Array([0.2]), "code-old");
      insertSymbolEmbedding(db, both, new Float32Array([0.3]), "code-new");
    },
    "code-new",
  );

  try {
    const status = await engine.status({ codePath });

    expect(status.symbol_embedding_status).toEqual({
      symbols: 2,
      total: 2,
      current_model: 1,
      stale: 1,
      model: "code-new",
    });

    const priority = status.priorities.find((p) => p.concept === "(symbol embeddings)");
    expect(priority?.action).toBe("refresh embeddings");
    expect(priority?.reason).toContain("1 of 2 embedded symbols");
    expect(priority?.reason).toContain("code-new");
    expect(priority?.reason).toContain("code-old");
    // A mind-level repair leads the concept work, so the compact view shows it.
    expect(status.priorities[0]?.concept).toBe("(symbol embeddings)");
    // The one figure for the embedding state moves with the symbol lane.
    expect(status.debt_components?.embedding_mismatch).toBeGreaterThan(0);
  } finally {
    removeDir(loreRoot);
    removeDir(codePath);
  }
});

test("status names the symbol lane when no code model is configured", async () => {
  const { engine, codePath, loreRoot } = await mindWithSymbolLane("symbol-lane-unset", (db) => {
    insertSymbolEmbedding(db, addSymbol(db, "orphaned-model"), new Float32Array([0.1]), "code-old");
  });

  try {
    const status = await engine.status({ codePath });

    expect(status.symbol_embedding_status?.model).toBeNull();
    expect(status.symbol_embedding_status?.stale).toBe(1);

    const priority = status.priorities.find((p) => p.concept === "(symbol embeddings)");
    expect(priority?.reason).toContain("no code model is configured");
    expect(priority?.reason).toContain("ai.embedding.code.model");
  } finally {
    removeDir(loreRoot);
    removeDir(codePath);
  }
});

test("status reports an emptied symbol lane against the live symbols", async () => {
  const { engine, codePath, loreRoot } = await mindWithSymbolLane(
    "symbol-lane-empty",
    (db) => {
      addSymbol(db, "one");
      addSymbol(db, "two");
    },
    "code-new",
  );

  try {
    const status = await engine.status({ codePath });

    // A code pass deletes the lane first and swallows a failed batch. The lane
    // is gone, not absent, and status must say so.
    expect(status.symbol_embedding_status).toMatchObject({ symbols: 2, total: 0, stale: 0 });
    expect(status.priorities.find((p) => p.concept === "(symbol embeddings)")).toBeUndefined();
  } finally {
    removeDir(loreRoot);
    removeDir(codePath);
  }
});
