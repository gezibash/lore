import { test, expect } from "bun:test";
import { defaultConfig } from "@/config/index.ts";
import { insertConcept } from "@/db/concepts.ts";
import { insertChunk } from "@/db/chunks.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { insertFtsContent } from "@/db/fts.ts";
import { upsertConceptSymbol } from "@/db/concept-symbols.ts";
import { insertSourceFile } from "@/db/source-files.ts";
import { insertSymbol } from "@/db/symbols.ts";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { serializeChunk } from "@/storage/frontmatter.ts";
import { reciprocalRankFusion, hybridSearch } from "./search.ts";
import type { StateChunkFrontmatter } from "@/types/index.ts";

interface EmbedderLike {
  embed: (value: string) => Promise<Float32Array>;
}

function writeStateChunk(
  dir: string,
  id: string,
  conceptName: string,
  conceptId: string,
  options?: { staleness?: number | null },
): void {
  const frontmatter = {
    fl_id: id,
    fl_type: "chunk" as const,
    fl_concept: conceptName,
    fl_concept_id: conceptId,
    fl_supersedes: null,
    fl_superseded_by: null,
    fl_narrative_origin: "init",
    fl_version: 1,
    fl_created_at: new Date().toISOString(),
    fl_residual: null,
    fl_staleness: options?.staleness ?? null,
    fl_cluster: null,
    fl_embedding_model: "test",
    fl_embedded_at: null,
    fl_lifecycle_status: "active",
    fl_archived_at: null,
    fl_lifecycle_reason: null,
    fl_merged_into_concept_id: null,
  };

  const raw = serializeChunk(frontmatter as unknown as StateChunkFrontmatter, "state content");
  writeTextFile(`${dir}/${id}.md`, raw);
}

test("reciprocalRankFusion combines rank scores from both lists", () => {
  const fused = reciprocalRankFusion(
    [
      [{ chunkId: "a" }, { chunkId: "b" }],
      [{ chunkId: "b" }, { chunkId: "c" }],
    ],
    10,
  );

  // With 0-indexed rank and k=10: score = w/(k+i) where i is 0-indexed position.
  // List 1: a=rank0→1/10, b=rank1→1/11. List 2: b=rank0→1/10, c=rank1→1/11.
  const byChunk = new Map(fused.map((item) => [item.chunkId, item.score]));
  expect(byChunk.get("b")).toBeCloseTo(1 / 11 + 1 / 10);
  expect(byChunk.get("a")).toBeCloseTo(1 / 10);
  expect(byChunk.get("c")).toBeCloseTo(1 / 11);
});

test("hybridSearch uses provided query embedding and skips embedder call", async () => {
  const db = createTestDb();
  const dir = createTempDir();

  try {
    const concept = insertConcept(db, "core-concept");
    const chunkId = "chunk-a";
    writeStateChunk(dir, chunkId, concept.name, concept.id);

    insertChunk(db, {
      id: chunkId,
      filePath: `${dir}/${chunkId}.md`,
      flType: "chunk",
      conceptId: concept.id,
      createdAt: new Date().toISOString(),
    });

    insertEmbedding(db, chunkId, new Float32Array([1, 0, 0, 0]), "test");
    insertFtsContent(db, "core concept facts", chunkId);

    let called = false;
    const embedder: EmbedderLike = {
      embed: async () => {
        called = true;
        return new Float32Array([0, 1, 0, 0]);
      },
    };

    const { results } = await hybridSearch(db, embedder, "core concept facts", defaultConfig, {
      sourceType: "chunk",
      limit: 5,
      queryEmbedding: new Float32Array([1, 0, 0, 0]),
    });

    expect(called).toBe(false);
    expect(results).toHaveLength(1);
    expect(results[0]!.concept).toBe(concept.name);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test("hybridSearch emits warning for high staleness", async () => {
  const db = createTestDb();
  const dir = createTempDir();

  try {
    const concept = insertConcept(db, "stale-concept");
    const chunkId = "chunk-b";
    writeStateChunk(dir, chunkId, concept.name, concept.id, { staleness: 0.8 });

    insertChunk(db, {
      id: chunkId,
      filePath: `${dir}/${chunkId}.md`,
      flType: "chunk",
      conceptId: concept.id,
      createdAt: new Date().toISOString(),
    });
    insertEmbedding(db, chunkId, new Float32Array([1, 0]), "test");
    insertFtsContent(db, "staleness warning", chunkId);

    const { results } = await hybridSearch(
      db,
      { embed: async () => new Float32Array([1, 0]) },
      "staleness warning",
      defaultConfig,
      {
        sourceType: "chunk",
        limit: 5,
        queryEmbedding: new Float32Array([1, 0]),
      },
    );

    expect(results[0]!.warning).toBe("content may be stale");
  } finally {
    db.close();
    removeDir(dir);
  }
});

test("hybridSearch skips missing chunks", async () => {
  const db = createTestDb();
  const dir = createTempDir();

  try {
    insertFtsContent(db, "ghost only", "ghost");

    const { results } = await hybridSearch(
      db,
      { embed: async () => new Float32Array([0, 0]) },
      "ghost only",
      defaultConfig,
      {
        sourceType: "chunk",
        limit: 5,
        queryEmbedding: new Float32Array([0, 0]),
      },
    );

    expect(results).toEqual([]);
  } finally {
    db.close();
    removeDir(dir);
  }
});

test("hybridSearch injects bound symbol bodies into concept results when codePath is available", async () => {
  const db = createTestDb();
  const dir = createTempDir();

  try {
    const concept = insertConcept(db, "bound-concept");
    const chunkId = "chunk-c";
    writeStateChunk(dir, chunkId, concept.name, concept.id);

    insertChunk(db, {
      id: chunkId,
      filePath: `${dir}/${chunkId}.md`,
      flType: "chunk",
      conceptId: concept.id,
      createdAt: new Date().toISOString(),
    });
    insertEmbedding(db, chunkId, new Float32Array([1, 0]), "test");
    insertFtsContent(db, "state content", chunkId);

    writeTextFile(
      `${dir}/src/example.ts`,
      [
        "export function alpha() {",
        "  return 'a'",
        "}",
        "",
        "export function beta() {",
        "  return 'b'",
        "}",
      ].join("\n"),
    );

    const sourceFile = insertSourceFile(db, {
      filePath: "src/example.ts",
      language: "typescript",
      contentHash: "hash",
      sizeBytes: 64,
      symbolCount: 2,
    });
    const alpha = insertSymbol(db, {
      sourceFileId: sourceFile.id,
      name: "alpha",
      qualifiedName: "alpha",
      kind: "function",
      parentId: null,
      lineStart: 1,
      lineEnd: 3,
      signature: "alpha()",
      bodyHash: "hash-alpha",
      exportStatus: "exported",
    });
    const beta = insertSymbol(db, {
      sourceFileId: sourceFile.id,
      name: "beta",
      qualifiedName: "beta",
      kind: "function",
      parentId: null,
      lineStart: 5,
      lineEnd: 7,
      signature: "beta()",
      bodyHash: "hash-beta",
      exportStatus: "exported",
    });

    upsertConceptSymbol(db, {
      conceptId: concept.id,
      symbolId: alpha.id,
      bindingType: "ref",
      boundBodyHash: alpha.body_hash,
      confidence: 0.95,
    });
    upsertConceptSymbol(db, {
      conceptId: concept.id,
      symbolId: beta.id,
      bindingType: "ref",
      boundBodyHash: beta.body_hash,
      confidence: 0.9,
    });

    const { results } = await hybridSearch(
      db,
      { embed: async () => new Float32Array([1, 0]) },
      "state content",
      defaultConfig,
      {
        sourceType: "chunk",
        limit: 5,
        queryEmbedding: new Float32Array([1, 0]),
        codePath: dir,
      },
    );

    expect(results).toHaveLength(1);
    expect(results[0]!.content).toContain("[Symbol: alpha (src/example.ts:1-3)]");
    expect(results[0]!.content).toContain("export function beta()");
  } finally {
    db.close();
    removeDir(dir);
  }
});
