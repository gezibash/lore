import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { relative, isAbsolute } from "path";
import type { IngestResult } from "@/types/index.ts";
import { discoverTextFiles, type DiscoveredTextFile } from "./file-discovery-text.ts";
import { mapConcurrent } from "./async.ts";
import { writeDocChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";
import {
  insertChunkBatch,
  insertFtsContentBatch,
  getDocChunkByPath,
  getDocChunkPaths,
  deleteDocChunksForFile,
} from "@/db/index.ts";

const DOC_PREPARE_CONCURRENCY = 4;

type PreparedDocIngest =
  | { kind: "skipped"; relPath: string }
  | { kind: "failed"; relPath: string }
  | {
      kind: "ingest";
      relPath: string;
      content: string;
      staged: { id: string; filePath: string };
      existingFilePath: string | null;
    };

async function readStoredDocBodyHash(filePath: string): Promise<string | null> {
  try {
    const chunkFile = await Bun.file(filePath).text();
    const match = chunkFile.match(/fl_body_hash:\s*['"]?([a-f0-9]+)['"]?/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function prepareDocIngest(
  db: Database,
  codePath: string,
  lorePath: string,
  absoluteFilePath: string,
): Promise<PreparedDocIngest> {
  const relPath = isAbsolute(absoluteFilePath)
    ? relative(codePath, absoluteFilePath)
    : absoluteFilePath;

  let content: string;
  try {
    content = await Bun.file(absoluteFilePath).text();
  } catch {
    return { kind: "skipped", relPath };
  }

  const bodyHash = createHash("sha256").update(content).digest("hex");
  const existing = getDocChunkByPath(db, relPath);
  if (existing) {
    const storedHash = await readStoredDocBodyHash(existing.file_path);
    if (storedHash === bodyHash) {
      return { kind: "skipped", relPath };
    }
  }

  try {
    const staged = await writeDocChunk({
      lorePath,
      docPath: relPath,
      bodyHash,
      content,
    });
    return {
      kind: "ingest",
      relPath,
      content,
      staged,
      existingFilePath: existing?.file_path ?? null,
    };
  } catch {
    return { kind: "failed", relPath };
  }
}

async function applyPreparedDocIngest(
  db: Database,
  prepared: Extract<PreparedDocIngest, { kind: "ingest" }>,
): Promise<"ingested" | "failed"> {
  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    if (prepared.existingFilePath) {
      deleteDocChunksForFile(db, prepared.relPath);
    }
    insertChunkBatch(db, [
      {
        id: prepared.staged.id,
        filePath: prepared.staged.filePath,
        flType: "doc",
        createdAt: new Date().toISOString(),
        sourceFilePath: prepared.relPath,
      },
    ]);
    insertFtsContentBatch(db, [{ content: prepared.content, chunkId: prepared.staged.id }]);
    db.run("COMMIT");
  } catch {
    db.run("ROLLBACK");
    await deleteSourceChunkFile(prepared.staged.filePath);
    return "failed";
  }

  if (prepared.existingFilePath) {
    try {
      await deleteSourceChunkFile(prepared.existingFilePath);
    } catch {
      // ignore cleanup failure after successful DB swap
    }
  }

  return "ingested";
}

export async function ingestDocFile(
  db: Database,
  codePath: string,
  lorePath: string,
  absoluteFilePath: string,
): Promise<"ingested" | "skipped" | "failed"> {
  const prepared = await prepareDocIngest(db, codePath, lorePath, absoluteFilePath);
  if (prepared.kind === "skipped") return "skipped";
  if (prepared.kind === "failed") return "failed";
  return applyPreparedDocIngest(db, prepared);
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
      await Promise.all(chunks.map((chunk) => deleteSourceChunkFile(chunk.file_path)));
      filesRemoved++;
    }
  }

  const prepared = await mapConcurrent(
    discovered,
    Math.min(DOC_PREPARE_CONCURRENCY, Math.max(1, discovered.length)),
    (file: DiscoveredTextFile) => prepareDocIngest(db, codePath, lorePath, file.absolutePath),
  );

  let filesIngested = 0;
  let filesSkipped = 0;
  let filesFailed = 0;
  for (const item of prepared) {
    if (item.kind === "skipped") {
      filesSkipped++;
      continue;
    }
    if (item.kind === "failed") {
      filesFailed++;
      continue;
    }
    const result = await applyPreparedDocIngest(db, item);
    if (result === "ingested") filesIngested++;
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
