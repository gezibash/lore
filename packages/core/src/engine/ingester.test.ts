import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { ingestDocFile, ingestTextFiles } from "./ingester.ts";
import { countOrphanedChunkRows, getDocChunkByPath } from "@/db/chunks.ts";
import { insertEmbeddingBatch } from "@/db/embeddings.ts";

test("ingestDocFile preserves the existing doc chunk when replacement staging fails", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const badLoreRoot = `${createTempDir("lore-bad-")}/not-a-directory`;
  const docPath = `${codeDir}/README.md`;

  try {
    writeTextFile(docPath, "# First\n");
    const first = await ingestDocFile(db, codeDir, loreDir, docPath);
    expect(first).toBe("ingested");

    const existing = getDocChunkByPath(db, "README.md");
    expect(existing).not.toBeNull();

    writeTextFile(badLoreRoot, "blocked");
    writeTextFile(docPath, "# Second\n");

    const failed = await ingestDocFile(db, codeDir, badLoreRoot, docPath);
    expect(failed).toBe("failed");

    const after = getDocChunkByPath(db, "README.md");
    expect(after).not.toBeNull();
    expect(after?.id).toBe(existing?.id);
    expect(after?.file_path).toBe(existing?.file_path);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
    removeDir(badLoreRoot.split("/not-a-directory")[0]!);
  }
});

/** Stand in for the engine's embed pass: one vector per chunk that lacks one. */
function embedMissingChunks(db: Database): void {
  const missing = db
    .query<{ id: string }, []>(
      `SELECT c.id FROM chunks c LEFT JOIN embeddings e ON e.chunk_id = c.id
       WHERE e.chunk_id IS NULL`,
    )
    .all();
  insertEmbeddingBatch(
    db,
    missing.map((c) => ({
      chunkId: c.id,
      embedding: new Float32Array([1, 0, 0, 0]),
      model: "test-embed",
    })),
  );
}

function countRows(db: Database, table: string): number {
  return db.query<{ n: number }, []>(`SELECT COUNT(*) AS n FROM ${table}`).get()?.n ?? 0;
}

test("a forced re-ingest leaves one embedding per chunk", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(`${codeDir}/README.md`, "# Title\n\nBody text.\n");
    writeTextFile(`${codeDir}/docs/guide.md`, "# Guide\n\nMore body text.\n");

    await ingestTextFiles(db, codeDir, loreDir);
    embedMissingChunks(db);
    const firstPass = countRows(db, "chunks");
    expect(firstPass).toBeGreaterThan(0);
    expect(countRows(db, "embeddings")).toBe(firstPass);

    // Re-chunking mints new chunk ids for the same files. The embeddings of the
    // chunks it replaces must go with them.
    await ingestTextFiles(db, codeDir, loreDir, { force: true });
    embedMissingChunks(db);

    expect(countRows(db, "chunks")).toBe(firstPass);
    expect(countRows(db, "embeddings")).toBe(countRows(db, "chunks"));
    expect(countRows(db, "content_fts")).toBe(countRows(db, "chunks"));
    expect(countOrphanedChunkRows(db)).toEqual({
      embeddings: 0,
      chunk_refs: 0,
      chunk_concept_map: 0,
      content_fts: 0,
    });
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});

test("ingestTextFiles names the documents it could not ingest", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");

  try {
    writeTextFile(`${codeDir}/README.md`, "# Title\n\nBody text.\n");
    // No text to extract: the file fails, and the count alone would hide it.
    writeTextFile(`${codeDir}/docs/empty.html`, "<html><body><div></div></body></html>\n");
    writeTextFile(
      `${codeDir}/docs/page.html`,
      '<html><head><meta charset="UTF-8"><title>T</title></head><body><h1>Hello</h1><p>Body text here.</p></body></html>\n',
    );

    const result = await ingestTextFiles(db, codeDir, loreDir);

    expect(result.failed_paths).toEqual(["docs/empty.html"]);
    expect(result.files_failed).toBe(1);
    expect(getDocChunkByPath(db, "docs/page.html")).not.toBeNull();
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
  }
});
