import type { Database } from "bun:sqlite";
import { createHash } from "crypto";
import { relative, isAbsolute } from "path";
import type { IngestResult } from "@/types/index.ts";
import { discoverTextFiles, type DiscoveredTextFile } from "./file-discovery-text.ts";
import { mapConcurrent } from "./async.ts";
import { writeDocChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";
import { extractDocxMarkdown } from "./docx.ts";
import {
  insertChunkBatch,
  insertFtsContentBatch,
  getDocChunkByPath,
  getDocChunkPaths,
  deleteDocChunksForFile,
} from "@/db/index.ts";

const DOC_PREPARE_CONCURRENCY = 4;

/** Minimum characters a heading section keeps to stand alone; smaller ones merge forward. */
const MIN_SECTION_CHARS = 200;

interface DocSection {
  headingPath: string;
  content: string;
}

/**
 * Split markdown into heading-scoped sections, each carrying its full heading
 * path (H1 > H2 > H3) as context. One chunk per whole file means one diluted
 * embedding and a 4k head-truncation at pack time — a 14k transports guide
 * loses every routing section past its intro. Non-markdown text falls back to
 * a single section.
 */
export function splitDocIntoSections(relPath: string, content: string): DocSection[] {
  if (!/\.(md|mdx|docx)$/i.test(relPath)) {
    return [{ headingPath: relPath, content }];
  }
  const lines = content.split("\n");
  const sections: DocSection[] = [];
  const trail: string[] = [];
  let current: string[] = [];
  let currentPath = relPath;
  let inFence = false;

  const flush = () => {
    const body = current.join("\n").trim();
    if (!body) return;
    const last = sections[sections.length - 1];
    if (last && last.content.length < MIN_SECTION_CHARS) {
      last.content = `${last.content}\n\n${body}`;
      last.headingPath = `${last.headingPath}`;
    } else {
      sections.push({ headingPath: currentPath, content: body });
    }
  };

  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const heading = !inFence ? /^(#{1,4})\s+(.*)$/.exec(line) : null;
    if (heading) {
      flush();
      current = [];
      const depth = heading[1]!.length;
      trail.length = depth - 1;
      trail[depth - 1] = heading[2]!.trim();
      currentPath = `${relPath} > ${trail.filter(Boolean).join(" > ")}`;
    }
    current.push(line);
  }
  flush();
  return sections.length > 0 ? sections : [{ headingPath: relPath, content }];
}

type PreparedDocIngest =
  | { kind: "skipped"; relPath: string }
  | { kind: "failed"; relPath: string }
  | {
      kind: "ingest";
      relPath: string;
      staged: Array<{ id: string; filePath: string; ftsText: string }>;
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
  force?: boolean,
): Promise<PreparedDocIngest> {
  const relPath = isAbsolute(absoluteFilePath)
    ? relative(codePath, absoluteFilePath)
    : absoluteFilePath;

  let content: string;
  try {
    if (/\.docx$/i.test(relPath)) {
      // Word packages are binary: convert to markdown so the heading-aware
      // section chunker treats them like any other doc.
      const extracted = extractDocxMarkdown(
        new Uint8Array(await Bun.file(absoluteFilePath).arrayBuffer()),
      );
      if (!extracted) return { kind: "failed", relPath };
      content = extracted;
    } else {
      content = await Bun.file(absoluteFilePath).text();
    }
  } catch {
    return { kind: "skipped", relPath };
  }

  const bodyHash = createHash("sha256").update(content).digest("hex");
  const existing = getDocChunkByPath(db, relPath);
  if (existing && !force) {
    const storedHash = await readStoredDocBodyHash(existing.file_path);
    if (storedHash === bodyHash) {
      return { kind: "skipped", relPath };
    }
  }

  try {
    const pathTokens = relPath.replace(/[/._-]+/g, " ");
    const staged = [];
    for (const section of splitDocIntoSections(relPath, content)) {
      const written = await writeDocChunk({
        lorePath,
        docPath: relPath,
        bodyHash,
        content: `[Doc: ${section.headingPath}]\n${section.content}`,
      });
      staged.push({
        ...written,
        ftsText: `${relPath} ${pathTokens} ${section.headingPath}\n${section.content}`,
      });
    }
    return {
      kind: "ingest",
      relPath,
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
    const createdAt = new Date().toISOString();
    insertChunkBatch(
      db,
      prepared.staged.map((section) => ({
        id: section.id,
        filePath: section.filePath,
        flType: "doc",
        createdAt,
        sourceFilePath: prepared.relPath,
      })),
    );
    insertFtsContentBatch(
      db,
      prepared.staged.map((section) => ({ content: section.ftsText, chunkId: section.id })),
    );
    db.run("COMMIT");
  } catch {
    db.run("ROLLBACK");
    await Promise.all(prepared.staged.map((s) => deleteSourceChunkFile(s.filePath)));
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
  opts?: { force?: boolean },
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
    (file: DiscoveredTextFile) => prepareDocIngest(db, codePath, lorePath, file.absolutePath, opts?.force),
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
