import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { resolveConfig } from "@/config/index.ts";
import { insertConceptRaw } from "@/db/concepts.ts";
import { getChunk, insertChunk } from "@/db/chunks.ts";
import { getEmbeddingForChunk, insertEmbedding } from "@/db/embeddings.ts";
import { getConcept } from "@/db/index.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { writeStateChunk } from "@/storage/index.ts";
import { createTestDb, createTempDir, removeDir } from "../../test/support/db.ts";
import {
  appendStateChunkForConcept,
  archiveConcept,
  renameConcept,
  type LifecycleDeps,
} from "./concept-lifecycle.ts";

const config = resolveConfig();
const model = config.ai.embedding.model;

/**
 * appendStateChunkForConcept is the write path every lifecycle op and the
 * close handler share. Its contract: the embedding call happens BEFORE any
 * state moves (network I/O must not sit between dependent DB writes), all
 * dependent writes commit in one transaction, and file mirrors are applied
 * only after — so a crash or failure can never leave chunks, FTS, embeddings
 * and concept versions disagreeing about what exists.
 */

interface Fixture {
  db: Database;
  lorePath: string;
  conceptId: string;
  v1ChunkId: string;
  deps(): LifecycleDeps;
}

async function seedFixture(content = "original prose"): Promise<Fixture> {
  const db = createTestDb();
  const lorePath = createTempDir("lore-lifecycle-");
  const conceptId = "c-1";
  insertConceptRaw(db, conceptId, "alpha", { activeChunkId: null });
  const v1 = await writeStateChunk({
    lorePath,
    concept: "alpha",
    conceptId,
    narrativeOrigin: "n-0",
    version: 1,
    content,
  });
  insertChunk(db, {
    id: v1.id,
    filePath: v1.filePath,
    flType: "chunk",
    conceptId,
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  insertEmbedding(db, v1.id, new Float32Array([1, 0, 0]), model);
  db.run("UPDATE concepts SET active_chunk_id = ? WHERE id = ?", [v1.id, conceptId]);
  return {
    db,
    lorePath,
    conceptId,
    v1ChunkId: v1.id,
    deps: () => ({
      db,
      lorePath,
      embeddingModel: model,
      getEmbedder: async () =>
        ({
          embed: async () => new Float32Array([0, 1, 0]),
          embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([0, 1, 0])),
        }) as never,
      getGenerator: async () => {
        throw new Error("generator must not be needed for chunk appends");
      },
    }),
  };
}

function cleanup(fixture: Fixture): void {
  removeDir(fixture.lorePath);
}

/** Frontmatter of a chunk, read back from disk as a loose record. */
async function frontmatterOf(fx: Fixture, chunkId: string): Promise<Record<string, unknown>> {
  return (await readChunk(getChunk(fx.db, chunkId)!.file_path)).frontmatter as unknown as Record<
    string,
    unknown
  >;
}

test("appendStateChunkForConcept commits chunk+fts+embedding+version together and mirrors files", async () => {
  const fx = await seedFixture();
  try {
    const before = getConcept(fx.db, fx.conceptId)!;
    const result = await appendStateChunkForConcept(
      fx.db,
      fx.lorePath,
      before,
      "updated prose",
      "lifecycle-patch:alpha",
      await fx.deps().getEmbedder(),
      model,
    );

    // Concept now points at a new chunk that supersedes v1.
    const after = getConcept(fx.db, fx.conceptId)!;
    expect(after.active_chunk_id).toBe(result.chunkId);
    expect(result.chunkId).not.toBe(fx.v1ChunkId);

    const newChunk = getChunk(fx.db, result.chunkId)!;
    expect(newChunk.supersedes_id).toBe(fx.v1ChunkId);
    expect(getEmbeddingForChunk(fx.db, result.chunkId)).not.toBeNull();

    // Residual is measured against the superseded chunk's embedding.
    expect(result.residual).toBeCloseTo(1); // [1,0,0] vs [0,1,0]

    // File mirrors applied post-commit.
    expect((await frontmatterOf(fx, fx.v1ChunkId)).fl_superseded_by).toBe(result.chunkId);
    const newFm = await frontmatterOf(fx, result.chunkId);
    expect(newFm.fl_version).toBe(2);
    expect(newFm.fl_staleness).toBe(0);
    expect(newFm.fl_residual).toBeCloseTo(1);
  } finally {
    cleanup(fx);
  }
});

test("a failed write mid-sequence rolls back the whole append", async () => {
  const fx = await seedFixture();
  try {
    // Force a real failure at the MIDDLE dependent write: the embedding
    // insert hits a missing table while the chunk row and its FTS entry
    // have already succeeded inside the transaction. Without the
    // transaction this left chunks/FTS applied with no embedding.
    fx.db.run("DROP TABLE embeddings");
    const before = getConcept(fx.db, fx.conceptId)!;

    let threw = false;
    try {
      await appendStateChunkForConcept(
        fx.db,
        fx.lorePath,
        before,
        "updated prose",
        "lifecycle-patch:alpha",
        await fx.deps().getEmbedder(),
        model,
      );
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);

    // Nothing moved: no chunk row, no embedding, concept still on v1...
    expect(getChunk(fx.db, fx.v1ChunkId)).not.toBeNull();
    const chunks = fx.db
      .query<{ id: string }, []>("SELECT id FROM chunks WHERE fl_type = 'chunk'")
      .all();
    expect(chunks.length).toBe(1);
    expect(getConcept(fx.db, fx.conceptId)!.active_chunk_id).toBe(fx.v1ChunkId);

    // ...and because markSuperseded runs after commit, the old chunk's file
    // was not marked superseded by an append that never happened.
    expect((await frontmatterOf(fx, fx.v1ChunkId)).fl_superseded_by).toBeNull();
  } finally {
    cleanup(fx);
  }
});

test("an embedding failure writes nothing at all", async () => {
  const fx = await seedFixture();
  try {
    const before = getConcept(fx.db, fx.conceptId)!;
    const failingDeps: LifecycleDeps = {
      db: fx.db,
      lorePath: fx.lorePath,
      embeddingModel: model,
      getEmbedder: async () =>
        ({
          embed: async () => {
            throw new Error("provider down");
          },
        }) as never,
      getGenerator: async () => {
        throw new Error("generator must not be needed for chunk appends");
      },
    };

    let message = "";
    try {
      await appendStateChunkForConcept(
        fx.db,
        fx.lorePath,
        before,
        "updated prose",
        "lifecycle-patch:alpha",
        await failingDeps.getEmbedder(),
        model,
      );
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe("provider down");

    const chunks = fx.db
      .query<{ id: string }, []>("SELECT id FROM chunks WHERE fl_type = 'chunk'")
      .all();
    expect(chunks.length).toBe(1);
    expect(getConcept(fx.db, fx.conceptId)!.active_chunk_id).toBe(fx.v1ChunkId);
    expect((await frontmatterOf(fx, fx.v1ChunkId)).fl_superseded_by).toBeNull();
  } finally {
    cleanup(fx);
  }
});

test("rename and archive stay lazy: no embedder or generator instantiated", async () => {
  const fx = await seedFixture();
  try {
    // The fixture's getGenerator throws on use; getEmbedder returns a stub
    // whose absence of calls we verify via the generator tripwire plus the
    // fact these ops complete without any provider.
    const deps = fx.deps();
    let embedderTouched = false;
    let generatorTouched = false;
    deps.getEmbedder = async () => {
      embedderTouched = true;
      throw new Error("embedder must not be used");
    };
    deps.getGenerator = async () => {
      generatorTouched = true;
      throw new Error("generator must not be used");
    };

    const renamed = await renameConcept(deps, "alpha", "alpha-renamed");
    expect(renamed.commit_id).not.toBeNull();

    const archived = await archiveConcept(deps, "alpha-renamed", "done");
    expect(archived.action).toBe("archive");
    expect(embedderTouched).toBe(false);
    expect(generatorTouched).toBe(false);
    expect(getConcept(fx.db, fx.conceptId)!.lifecycle_status).toBe("archived");
  } finally {
    cleanup(fx);
  }
});
