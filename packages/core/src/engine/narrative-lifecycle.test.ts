import { expect, test } from "bun:test";
import { readdir } from "fs/promises";

import { defaultConfig } from "@/config/index.ts";
import { insertChunk } from "@/db/chunks.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { insertNarrative, insertNarrativeRaw } from "@/db/narratives.ts";
import { ensureDir, mainDir, writeJournalChunk } from "@/storage/index.ts";
import { closeNarrativeOp, openNarrative } from "./narrative-lifecycle.ts";
import type { Embedder } from "./embedder.ts";
import type { Generator } from "./generator.ts";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";

test("openNarrative rejects unsupported dangling resolution actions", async () => {
  const db = createTestDb();
  const config = defaultConfig;
  const openedAt = new Date(
    Date.now() - (config.thresholds.dangling_days + 1) * 24 * 60 * 60 * 1000,
  ).toISOString();

  insertNarrativeRaw(db, "dangling-id", "old-work", {
    intent: "stale narrative",
    status: "open",
    entryCount: 0,
    openedAt,
  });

  await expect(
    openNarrative(db, "/tmp/lore-test", "new-work", "continue", config, {} as never, {
      narrative: "old-work",
      action: "close" as never,
    }),
  ).rejects.toMatchObject({ code: "DANGLING_NARRATIVE" });
});

/**
 * The state chunk files are written before the batch embed. A rejected batch
 * used to leave one file per concept on disk with no row in `chunks`, and the
 * retry wrote more under new IDs.
 */
test("a failed close removes the state chunk files it wrote", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-close-");
  try {
    const config = defaultConfig;
    const narrative = insertNarrative(db, "leaky-close", "write two concepts", null, [
      { op: "create", concept: "alpha" },
      { op: "create", concept: "beta" },
    ]);
    for (const concept of ["alpha", "beta"]) {
      const chunk = await writeJournalChunk({
        lorePath,
        narrativeName: "leaky-close",
        content: `A journal entry about ${concept}.`,
        conceptDesignations: [concept],
      });
      insertChunk(db, {
        id: chunk.id,
        filePath: chunk.filePath,
        flType: "journal",
        narrativeId: narrative.id,
        conceptDesignations: [concept],
        createdAt: new Date().toISOString(),
      });
      // Pre-embedded, so the only batch left to fail is the state batch.
      insertEmbedding(db, chunk.id, new Float32Array([1, 0, 0]), config.ai.embedding.model);
    }

    const generator = {
      generateIntegration: async (
        _entries: string[],
        _existing: string[],
        conceptName: string,
      ): Promise<string> => `The ${conceptName} concept holds the rules.`,
      generate: async (): Promise<string> => "",
    } as unknown as Generator;
    const embedder = {
      embed: async () => new Float32Array([1, 0, 0]),
      embedBatch: async () => {
        throw new Error("Failed to batch embed");
      },
    } as unknown as Embedder;

    await ensureDir(mainDir(lorePath));
    await expect(
      closeNarrativeOp(db, lorePath, "leaky-close", config, embedder, generator),
    ).rejects.toThrow(/Failed to batch embed/);

    expect(await readdir(mainDir(lorePath))).toEqual([]);
  } finally {
    db.close();
    removeDir(lorePath);
  }
});
