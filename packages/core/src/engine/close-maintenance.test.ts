import { expect, test } from "bun:test";

import { defaultConfig } from "@/config/index.ts";
import { insertConceptRaw } from "@/db/concepts.ts";
import { insertChunk } from "@/db/chunks.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { insertNarrativeRaw } from "@/db/narratives.ts";
import { getActiveConcepts, getManifest } from "@/db/index.ts";
import { writeStateChunk } from "@/storage/index.ts";
import { runCloseMaintenanceJob } from "./narrative-lifecycle.ts";
import { createTestDb, createTempDir, removeDir } from "../../test/support/db.ts";

/**
 * Close maintenance with no code path: e_embed cannot be measured, so the
 * only number on hand is churn — how far the prose moved between versions.
 * The old path wrote churn as ground_residual (debt then read a big legit
 * rewrite as "the prose is wrong") and as the `residual` column. Under the
 * spec churn is a change rate, not evidence: ground_residual stays null and
 * `residual` is refreshed from the axes as the R(c) cache.
 */
test("maintenance keeps churn out of ground_residual and caches R(c) in residual", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-maint-");
  try {
    const config = defaultConfig;
    const conceptId = "c-rewritten";
    insertNarrativeRaw(db, "n-1", "rewrite", {
      intent: "rewrite the concept",
      status: "closed",
      entryCount: 1,
      openedAt: "2026-01-01T00:00:00.000Z",
      closedAt: "2026-01-02T00:00:00.000Z",
    });
    insertConceptRaw(db, conceptId, "rewritten", { activeChunkId: null });

    const old = await writeStateChunk({
      lorePath,
      concept: "rewritten",
      conceptId,
      narrativeOrigin: "n-0",
      version: 1,
      content: "The old description.",
    });
    const next = await writeStateChunk({
      lorePath,
      concept: "rewritten",
      conceptId,
      narrativeOrigin: "n-1",
      version: 2,
      supersedes: old.id,
      content: "A completely different description after the rewrite.",
    });
    for (const chunk of [old, next]) {
      insertChunk(db, {
        id: chunk.id,
        filePath: chunk.filePath,
        flType: "chunk",
        conceptId,
        narrativeId: "n-1",
        supersedesId: chunk === next ? old.id : null,
        createdAt: "2026-01-02T00:00:00.000Z",
      });
    }
    db.run("UPDATE concepts SET active_chunk_id = ? WHERE id = ?", [next.id, conceptId]);
    // 45° apart → churn (cosine distance) ≈ 0.29: the prose clearly moved.
    // That must not become "the prose is wrong" (ground_residual) and must
    // not be what the residual cache holds.
    insertEmbedding(db, old.id, new Float32Array([1, 0, 0]), config.ai.embedding.model);
    insertEmbedding(db, next.id, new Float32Array([1, 1, 0]), config.ai.embedding.model);

    await runCloseMaintenanceJob(
      db,
      {
        narrativeId: "n-1",
        codePath: null,
        residualPairs: [{ conceptId, newChunkId: next.id, oldChunkId: old.id }],
        entryConceptPairs: [],
      },
      config,
      { embed: async () => new Float32Array(), embedBatch: async () => [] } as never,
      {} as never,
    );

    const concept = getActiveConcepts(db).find((c) => c.id === conceptId)!;
    expect(concept.churn).toBeCloseTo(1 - Math.SQRT1_2, 5);
    expect(concept.ground_residual).toBeNull(); // unmeasured — not churn, not 0
    // Unbound → ungrounded → R(c) = 1. The old code stored residual = churn.
    expect(concept.residual).toBe(1);
    expect(getManifest(db)?.debt).toBe(1);
  } finally {
    removeDir(lorePath);
  }
});
