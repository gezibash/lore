import { expect, test } from "bun:test";
import { readdir } from "fs/promises";

import { defaultConfig } from "@/config/index.ts";
import { insertChunk } from "@/db/chunks.ts";
import { getActiveConceptByName, insertConceptRaw } from "@/db/concepts.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { insertNarrative, insertNarrativeRaw } from "@/db/narratives.ts";
import { ensureDir, mainDir, writeJournalChunk, writeStateChunk } from "@/storage/index.ts";
import { closeNarrativeOp, openNarrative } from "./narrative-lifecycle.ts";
import type { Embedder } from "./embedder.ts";
import type { Generator } from "./generator.ts";
import type { ConceptLifecycleStatus } from "@/types/index.ts";
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

const bodyGenerator = {
  generateIntegration: async (
    _entries: string[],
    _existing: string[],
    conceptName: string,
  ): Promise<string> => `The ${conceptName} concept holds the new rules.`,
  generate: async (): Promise<string> => "",
} as unknown as Generator;

const okEmbedder = {
  embed: async () => new Float32Array([1, 0, 0]),
  embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 0, 0])),
} as unknown as Embedder;

/** An inactive concept: the record and its last chunk stay, the name is hidden. */
async function seedInactiveConcept(
  db: ReturnType<typeof createTestDb>,
  lorePath: string,
  conceptName: string,
  status: ConceptLifecycleStatus,
  opts?: { mergedIntoConceptId?: string },
): Promise<{ conceptId: string; chunkId: string }> {
  const conceptId = `c-${conceptName}`;
  insertConceptRaw(db, conceptId, conceptName, {
    activeChunkId: null,
    lifecycleStatus: status,
    archivedAt: "2026-01-01T00:00:00.000Z",
    lifecycleReason: status,
    mergedIntoConceptId: opts?.mergedIntoConceptId ?? null,
  });
  const chunk = await writeStateChunk({
    lorePath,
    concept: conceptName,
    conceptId,
    narrativeOrigin: "seed",
    version: 2,
    content: "The old rules.",
  });
  insertChunk(db, {
    id: chunk.id,
    filePath: chunk.filePath,
    flType: "chunk",
    conceptId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  return { conceptId, chunkId: chunk.id };
}

async function seedCreateNarrative(
  db: ReturnType<typeof createTestDb>,
  lorePath: string,
  narrativeName: string,
  conceptName: string,
): Promise<void> {
  const narrative = insertNarrative(db, narrativeName, `write ${conceptName}`, null, [
    { op: "create", concept: conceptName },
  ]);
  const chunk = await writeJournalChunk({
    lorePath,
    narrativeName,
    content: `A journal entry about ${conceptName}.`,
    conceptDesignations: [conceptName],
  });
  insertChunk(db, {
    id: chunk.id,
    filePath: chunk.filePath,
    flType: "journal",
    narrativeId: narrative.id,
    conceptDesignations: [conceptName],
    createdAt: new Date().toISOString(),
  });
  insertEmbedding(db, chunk.id, new Float32Array([1, 0, 0]), defaultConfig.ai.embedding.model);
}

/**
 * Archive frees the name in `lore ls` but keeps the record. A create over that
 * name used to report success and stay hidden until a manual restore.
 */
test("a create over an archived name restores the concept and writes the new body", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-close-");
  try {
    const archived = await seedInactiveConcept(db, lorePath, "posting-rules", "archived");
    await seedCreateNarrative(db, lorePath, "rebuild-posting", "posting-rules");

    const result = await closeNarrativeOp(
      db,
      lorePath,
      "rebuild-posting",
      defaultConfig,
      okEmbedder,
      bodyGenerator,
    );

    expect(result.concepts_created).toEqual(["posting-rules"]);
    expect(result.follow_up).toContain("posting-rules");

    const concept = getActiveConceptByName(db, "posting-rules");
    expect(concept?.id).toBe(archived.conceptId);
    expect(concept?.lifecycle_status).toBe("active");
    expect(concept?.archived_at).toBeNull();
    expect(concept?.active_chunk_id).not.toBe(archived.chunkId);
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("a create over a merged name fails and names the concept it was merged into", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-close-");
  try {
    insertConceptRaw(db, "c-ledger-rules", "ledger-rules", { activeChunkId: null });
    await seedInactiveConcept(db, lorePath, "posting-rules", "merged", {
      mergedIntoConceptId: "c-ledger-rules",
    });
    await seedCreateNarrative(db, lorePath, "rebuild-posting", "posting-rules");

    await expect(
      closeNarrativeOp(db, lorePath, "rebuild-posting", defaultConfig, okEmbedder, bodyGenerator),
    ).rejects.toMatchObject({
      code: "CONCEPT_INVALID_STATE",
      message: expect.stringContaining("ledger-rules"),
    });
  } finally {
    db.close();
    removeDir(lorePath);
  }
});
