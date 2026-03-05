import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { relative, isAbsolute } from "path";
import type { IngestResult } from "@/types/index.ts";
import { discoverTextFiles } from "./file-discovery-text.ts";
import { writeDocChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";
import { insertChunk, insertFtsContent, getDocChunkByPath, getDocChunkPaths, deleteDocChunksForFile } from "@/db/index.ts";

export async function ingestDocFile(
  db: Database,
  codePath: string,
  lorePath: string,
  absoluteFilePath: string,
): Promise<"ingested" | "skipped" | "failed"> {
  let content: string;
  try {
    content = await Bun.file(absoluteFilePath).text();
  } catch {
    return "skipped";
  }

  const bodyHash = createHash("sha256").update(content).digest("hex");
  const relPath = isAbsolute(absoluteFilePath)
    ? relative(codePath, absoluteFilePath)
    : absoluteFilePath;

  const existing = getDocChunkByPath(db, relPath);
  if (existing) {
    // Check if the file content changed by reading the stored hash from frontmatter
    // We store the hash in source_file_path-adjacent manner — use a query on the chunk row
    // The hash is in the frontmatter file on disk. For simplicity, re-read the frontmatter.
    // Actually: we need another approach. Let's add a body_hash column query or store hash in DB.
    // Since the chunks table doesn't have a body_hash column for doc chunks, we store hash
    // in the file frontmatter. But to avoid disk reads on every check, let's query the chunk
    // file_path and read frontmatter.
    // Simpler: use the FTS approach — if same file_path + same hash → skip.
    // We'll read the chunk file to get the stored hash.
    try {
      const chunkFile = await Bun.file(existing.file_path).text();
      // Look for fl_body_hash in frontmatter
      const match = chunkFile.match(/fl_body_hash:\s*['"]?([a-f0-9]+)['"]?/);
      const storedHash = match?.[1];
      if (storedHash === bodyHash) return "skipped";
    } catch {
      // If we can't read the file, re-ingest
    }
  }

  let staged: { id: string; filePath: string };
  try {
    staged = await writeDocChunk({
      lorePath,
      docPath: relPath,
      bodyHash,
      content,
    });
  } catch {
    return "failed";
  }

  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    if (existing) {
      deleteDocChunksForFile(db, relPath);
    }
    insertChunk(db, {
      id: staged.id,
      filePath: staged.filePath,
      flType: "doc",
      createdAt: new Date().toISOString(),
      sourceFilePath: relPath,
    });
    insertFtsContent(db, content, staged.id);
    db.run("COMMIT");
  } catch {
    db.run("ROLLBACK");
    await deleteSourceChunkFile(staged.filePath);
    return "failed";
  }

  if (existing) {
    try { await deleteSourceChunkFile(existing.file_path); } catch { /* ignore */ }
  }

  return "ingested";
}

export async function ingestTextFiles(
  db: Database,
  codePath: string,
  lorePath: string,
): Promise<IngestResult> {
  const start = performance.now();
  const discovered = discoverTextFiles(codePath, lorePath);
  const discoveredPaths = new Set(discovered.map((f) => f.relativePath));

  // Detect deleted files
  const existingPaths = getDocChunkPaths(db);
  let filesRemoved = 0;
  for (const p of existingPaths) {
    if (!discoveredPaths.has(p)) {
      const chunks = db
        .query<{ file_path: string }, [string]>(
          `SELECT file_path FROM chunks WHERE fl_type = 'doc' AND source_file_path = ?`,
        )
        .all(p);
      deleteDocChunksForFile(db, p);
      for (const c of chunks) {
        try { await deleteSourceChunkFile(c.file_path); } catch { /* ignore */ }
      }
      filesRemoved++;
    }
  }

  let filesIngested = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  for (const file of discovered) {
    const result = await ingestDocFile(db, codePath, lorePath, file.absolutePath);
    if (result === "ingested") filesIngested++;
    else if (result === "skipped") filesSkipped++;
    else filesFailed++;
  }

  return {
    files_ingested: filesIngested,
    files_skipped: filesSkipped,
    files_removed: filesRemoved,
    files_failed: filesFailed,
    duration_ms: Math.round(performance.now() - start),
  };
}
