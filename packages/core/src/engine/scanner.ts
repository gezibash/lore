import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import type {
  ScanResult,
  SymbolKind,
  ExtractedSymbol,
  BindingType,
  SupportedLanguage,
  ExtractedCallSite,
  DiscoveredFile,
  SourceFileRow,
} from "@/types/index.ts";
import { discoverFiles, isTsxFile } from "./file-discovery.ts";
import { mapConcurrent } from "./async.ts";
import { TreeSitterPool } from "./tree-sitter.ts";
import { extractSymbols, extractCallSites } from "./symbol-queries.ts";
import {
  upsertSourceFile,
  getSourceFileByPath,
  getAllSourceFiles,
  deleteSourceFile,
} from "@/db/source-files.ts";
import { insertSymbolBatch, deleteSymbolsForSourceFile, getSymbolsForSourceFile } from "@/db/symbols.ts";
import { insertCallSiteBatch, deleteCallSitesForSourceFile } from "@/db/call-sites.ts";
import { getBindingsForSymbol, upsertConceptSymbol } from "@/db/concept-symbols.ts";
import { insertChunkBatch, getSourceChunkPathsForFile, deleteSourceChunksForFile } from "@/db/chunks.ts";
import { insertFtsContentBatch } from "@/db/fts.ts";
import { writeSourceChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";

const SCAN_PREPARE_CONCURRENCY = 4;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Snapshot all binding associations for a source file, keyed by qualified_name.
 *  Call before deleting old symbol rows so bindings can be rematched after re-insert. */
function saveBindingsForSourceFile(
  db: Database,
  sourceFileId: string,
): Map<string, Array<{ concept_id: string; binding_type: string; confidence: number }>> {
  const saved = new Map<
    string,
    Array<{ concept_id: string; binding_type: string; confidence: number }>
  >();
  const oldSymbols = getSymbolsForSourceFile(db, sourceFileId);
  for (const sym of oldSymbols) {
    const bindings = getBindingsForSymbol(db, sym.id);
    if (bindings.length > 0) {
      saved.set(
        sym.qualified_name,
        bindings.map((b) => ({
          concept_id: b.concept_id,
          binding_type: b.binding_type,
          confidence: b.confidence,
        })),
      );
    }
  }
  return saved;
}

/** Re-attach previously saved bindings to freshly inserted symbol rows (matched by qualified_name). */
function rematchBindings(
  db: Database,
  saved: Map<string, Array<{ concept_id: string; binding_type: string; confidence: number }>>,
  newSourceFileId: string,
  fileContent?: string,
): void {
  if (saved.size === 0) return;
  const newSymbols = getSymbolsForSourceFile(db, newSourceFileId);
  const contentLines = fileContent ? fileContent.split("\n") : null;
  for (const sym of newSymbols) {
    const oldBindings = saved.get(sym.qualified_name);
    if (!oldBindings) continue;
    const boundBody = contentLines && sym.line_start != null && sym.line_end != null
      ? contentLines.slice(sym.line_start - 1, sym.line_end).join("\n")
      : null;
    for (const b of oldBindings) {
      upsertConceptSymbol(db, {
        conceptId: b.concept_id,
        symbolId: sym.id,
        bindingType: b.binding_type as BindingType,
        boundBodyHash: sym.body_hash,
        boundBody,
        confidence: b.confidence,
      });
    }
  }
}

interface SymbolForChunk {
  qualified_name: string;
  kind: string;
  line_start: number;
  line_end: number;
  body_hash: string | null;
}

interface WrittenSourceChunk {
  id: string;
  filePath: string;
  body: string;
}

async function cleanupChunkFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => deleteSourceChunkFile(filePath)));
}

/** Write one source chunk file per symbol. Returns the staged files for later DB insertion. */
async function writeSourceChunkFilesForSymbols(
  lorePath: string,
  sourceFile: string,
  language: SupportedLanguage,
  symbols: SymbolForChunk[],
  content: string,
): Promise<WrittenSourceChunk[]> {
  if (symbols.length === 0) return [];
  const written: WrittenSourceChunk[] = [];
  const contentLines = content.split("\n");
  try {
    for (const sym of symbols) {
      const body = contentLines.slice(sym.line_start - 1, sym.line_end).join("\n");
      const { id, filePath } = await writeSourceChunk({
        lorePath,
        sourceFile,
        lineStart: sym.line_start,
        lineEnd: sym.line_end,
        symbol: sym.qualified_name,
        kind: sym.kind as SymbolKind,
        language,
        bodyHash: sym.body_hash,
        body,
      });
      written.push({ id, filePath, body });
    }
  } catch (error) {
    await cleanupChunkFiles(written.map((chunk) => chunk.filePath));
    throw error;
  }
  return written;
}

function insertSourceChunks(
  db: Database,
  sourceFile: string,
  chunks: WrittenSourceChunk[],
): number {
  if (chunks.length === 0) return 0;
  const createdAt = new Date().toISOString();
  insertChunkBatch(
    db,
    chunks.map((chunk) => ({
      id: chunk.id,
      filePath: chunk.filePath,
      flType: "source",
      createdAt,
      sourceFilePath: sourceFile,
    })),
  );
  insertFtsContentBatch(
    db,
    chunks.map((chunk) => ({ content: chunk.body, chunkId: chunk.id })),
  );
  return chunks.length;
}

type PreparedSourceScan =
  | { kind: "unreadable"; file: DiscoveredFile }
  | { kind: "failed"; file: DiscoveredFile }
  | {
      kind: "skipped";
      file: DiscoveredFile;
      existing: SourceFileRow;
      writtenChunks: WrittenSourceChunk[];
    }
  | {
      kind: "update";
      file: DiscoveredFile;
      existing: SourceFileRow | null;
      content: string;
      contentHash: string;
      sizeBytes: number;
      symbols: ExtractedSymbol[];
      callSites: ExtractedCallSite[];
      writtenChunks: WrittenSourceChunk[];
      oldPaths: string[];
    };

async function prepareSourceScanFile(
  db: Database,
  pool: TreeSitterPool,
  lorePath: string | undefined,
  file: DiscoveredFile,
  existingByPath: Map<string, SourceFileRow>,
): Promise<PreparedSourceScan> {
  let content: string;
  try {
    content = await Bun.file(file.absolutePath).text();
  } catch {
    return { kind: "unreadable", file };
  }

  const sizeBytes = Buffer.byteLength(content, "utf-8");
  const contentHash = createHash("sha256").update(content).digest("hex");
  const existing = existingByPath.get(file.relativePath) ?? null;

  if (existing && existing.content_hash === contentHash) {
    if (lorePath && existing.symbol_count > 0) {
      const existingSourcePaths = getSourceChunkPathsForFile(db, file.relativePath);
      if (existingSourcePaths.length === 0) {
        const existingSymbols = getSymbolsForSourceFile(db, existing.id);
        try {
          const writtenChunks = await writeSourceChunkFilesForSymbols(
            lorePath,
            file.relativePath,
            file.language,
            existingSymbols,
            content,
          );
          return { kind: "skipped", file, existing, writtenChunks };
        } catch {
          return { kind: "failed", file };
        }
      }
    }
    return { kind: "skipped", file, existing, writtenChunks: [] };
  }

  const isTsx = isTsxFile(file.relativePath);
  let symbols: ExtractedSymbol[];
  let callSites: ExtractedCallSite[] = [];
  try {
    const { tree, lang } = await pool.parse(content, file.language, isTsx);
    symbols = extractSymbols(tree, lang, file.language, content, pool);
    callSites = extractCallSites(tree, lang, file.language, content, pool);
    tree.delete();
  } catch {
    return { kind: "failed", file };
  }

  let writtenChunks: WrittenSourceChunk[] = [];
  if (lorePath && symbols.length > 0) {
    try {
      writtenChunks = await writeSourceChunkFilesForSymbols(
        lorePath,
        file.relativePath,
        file.language,
        symbols,
        content,
      );
    } catch {
      return { kind: "failed", file };
    }
  }

  return {
    kind: "update",
    file,
    existing,
    content,
    contentHash,
    sizeBytes,
    symbols,
    callSites,
    writtenChunks,
    oldPaths: lorePath && existing ? getSourceChunkPathsForFile(db, file.relativePath) : [],
  };
}

async function applyPreparedSkippedSourceFile(
  db: Database,
  prepared: Extract<PreparedSourceScan, { kind: "skipped" }>,
): Promise<number> {
  if (prepared.writtenChunks.length === 0) return 0;
  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const insertedCount = insertSourceChunks(db, prepared.file.relativePath, prepared.writtenChunks);
    db.run("COMMIT");
    return insertedCount;
  } catch (error) {
    db.run("ROLLBACK");
    await cleanupChunkFiles(prepared.writtenChunks.map((chunk) => chunk.filePath));
    throw error;
  }
}

async function applyPreparedUpdatedSourceFile(
  db: Database,
  prepared: Extract<PreparedSourceScan, { kind: "update" }>,
): Promise<number> {
  let insertedSourceChunks = 0;
  db.run("BEGIN IMMEDIATE TRANSACTION");
  try {
    const savedBindings = prepared.existing
      ? saveBindingsForSourceFile(db, prepared.existing.id)
      : new Map();
    if (prepared.existing) {
      deleteSourceChunksForFile(db, prepared.file.relativePath);
      deleteSymbolsForSourceFile(db, prepared.existing.id);
      deleteCallSitesForSourceFile(db, prepared.existing.id);
    }

    const sourceFile = upsertSourceFile(db, {
      filePath: prepared.file.relativePath,
      language: prepared.file.language,
      contentHash: prepared.contentHash,
      sizeBytes: prepared.sizeBytes,
      symbolCount: prepared.symbols.length,
    });

    if (prepared.symbols.length > 0) {
      insertSymbolBatch(
        db,
        sourceFile.id,
        prepared.file.relativePath,
        prepared.symbols.map((symbol) => ({
          sourceFileId: sourceFile.id,
          name: symbol.name,
          qualifiedName: symbol.qualified_name,
          kind: symbol.kind as SymbolKind,
          parentId: null as string | null,
          lineStart: symbol.line_start,
          lineEnd: symbol.line_end,
          signature: symbol.signature,
          bodyHash: symbol.body_hash,
          exportStatus: symbol.export_status,
        })),
      );
    }

    rematchBindings(db, savedBindings, sourceFile.id, prepared.content);

    if (prepared.writtenChunks.length > 0) {
      insertedSourceChunks = insertSourceChunks(
        db,
        prepared.file.relativePath,
        prepared.writtenChunks,
      );
    }

    if (prepared.callSites.length > 0) {
      insertCallSiteBatch(
        db,
        sourceFile.id,
        prepared.callSites.map((callSite) => ({
          callee_name: callSite.callee_name,
          caller_name: callSite.caller_context === "<module>" ? null : callSite.caller_context,
          line: callSite.line,
          snippet: callSite.snippet,
        })),
      );
    }

    db.run("COMMIT");
  } catch (error) {
    db.run("ROLLBACK");
    await cleanupChunkFiles(prepared.writtenChunks.map((chunk) => chunk.filePath));
    throw error;
  }

  if (prepared.oldPaths.length > 0) {
    await cleanupChunkFiles(prepared.oldPaths);
  }

  return insertedSourceChunks;
}

// ─── scanProject ─────────────────────────────────────────────────────────────

export async function scanProject(
  db: Database,
  codePath: string,
  lorePath?: string,
): Promise<ScanResult> {
  const start = performance.now();
  const files = discoverFiles(codePath);
  const currentPaths = new Set(files.map((file) => file.relativePath));
  const existingByPath = new Map(getAllSourceFiles(db).map((file) => [file.file_path, file]));

  const pool = new TreeSitterPool();
  await pool.init();

  let filesScanned = 0;
  let filesSkipped = 0;
  let symbolsFound = 0;
  let callSitesFound = 0;
  let sourceChunksFound = 0;
  let filesFailed = 0;
  const languages: Record<string, number> = {};

  const preparedFiles = await mapConcurrent(
    files,
    Math.min(SCAN_PREPARE_CONCURRENCY, Math.max(1, files.length)),
    (file) => prepareSourceScanFile(db, pool, lorePath, file, existingByPath),
  );

  for (const prepared of preparedFiles) {
    if (prepared.kind === "unreadable") {
      continue;
    }

    if (prepared.kind === "skipped") {
      filesSkipped++;
      languages[prepared.file.language] =
        (languages[prepared.file.language] ?? 0) + prepared.existing.symbol_count;
      symbolsFound += prepared.existing.symbol_count;
      if (prepared.writtenChunks.length > 0) {
        try {
          sourceChunksFound += await applyPreparedSkippedSourceFile(db, prepared);
        } catch {
          filesFailed++;
        }
      }
      continue;
    }

    if (prepared.kind === "failed") {
      filesFailed++;
      continue;
    }

    try {
      sourceChunksFound += await applyPreparedUpdatedSourceFile(db, prepared);
    } catch {
      filesFailed++;
      continue;
    }

    filesScanned++;
    symbolsFound += prepared.symbols.length;
    callSitesFound += prepared.callSites.length;
    languages[prepared.file.language] =
      (languages[prepared.file.language] ?? 0) + prepared.symbols.length;
  }

  // Remove source files for files no longer on disk
  const allExisting = getAllSourceFiles(db);
  let filesRemoved = 0;
  for (const f of allExisting) {
    if (!currentPaths.has(f.file_path)) {
      const oldPaths = lorePath ? getSourceChunkPathsForFile(db, f.file_path) : [];
      db.run("BEGIN IMMEDIATE TRANSACTION");
      try {
        if (lorePath) {
          deleteSourceChunksForFile(db, f.file_path);
        }
        deleteSymbolsForSourceFile(db, f.id);
        deleteCallSitesForSourceFile(db, f.id);
        deleteSourceFile(db, f.id);
        db.run("COMMIT");
      } catch {
        db.run("ROLLBACK");
        filesFailed++;
        continue;
      }
      if (oldPaths.length > 0) {
        await cleanupChunkFiles(oldPaths);
      }
      filesRemoved++;
    }
  }

  const duration = performance.now() - start;

  return {
    files_scanned: filesScanned,
    files_skipped: filesSkipped,
    files_removed: filesRemoved,
    symbols_found: symbolsFound,
    call_sites_found: callSitesFound,
    source_chunks_found: sourceChunksFound,
    files_failed: filesFailed,
    languages,
    duration_ms: Math.round(duration),
  };
}

/**
 * Targeted rescan of specific file paths. Same incremental logic as scanProject
 * but scoped to only the given files. Used during narrative close to ensure symbol
 * index is fresh for files touched by refs before binding extraction.
 */
export async function rescanFiles(
  db: Database,
  codePath: string,
  filePaths: string[],
  lorePath?: string,
): Promise<{ rescanned: number; symbolsFound: number }> {
  if (filePaths.length === 0) return { rescanned: 0, symbolsFound: 0 };

  const pool = new TreeSitterPool();
  await pool.init();

  let rescanned = 0;
  let symbolsFound = 0;

  for (const relativePath of filePaths) {
    const absolutePath = relativePath.startsWith("/")
      ? relativePath
      : `${codePath}/${relativePath}`;

    let content: string;
    let stat: { size: number };
    try {
      content = readFileSync(absolutePath, "utf-8");
      stat = { size: Buffer.byteLength(content, "utf-8") };
    } catch {
      continue;
    }

    const contentHash = createHash("sha256").update(content).digest("hex");

    const existing = getSourceFileByPath(db, relativePath);
    if (existing && existing.content_hash === contentHash) {
      symbolsFound += existing.symbol_count;
      continue;
    }

    // Detect language from extension
    const ext = relativePath.split(".").pop()?.toLowerCase();
    let language: SupportedLanguage;
    switch (ext) {
      case "ts":
      case "tsx":
        language = "typescript";
        break;
      case "js":
      case "jsx":
      case "mjs":
      case "cjs":
        language = "javascript";
        break;
      case "py":
        language = "python";
        break;
      case "go":
        language = "go";
        break;
      case "rs":
        language = "rust";
        break;
      default:
        continue;
    }

    const isTsx = isTsxFile(relativePath);
    let symbols: ExtractedSymbol[];
    let callSites: ExtractedCallSite[] = [];
    try {
      const { tree, lang } = await pool.parse(content, language, isTsx);
      symbols = extractSymbols(tree, lang, language, content, pool);
      callSites = extractCallSites(tree, lang, language, content, pool);
      tree.delete();
    } catch {
      continue;
    }

    const oldPaths = lorePath && existing ? getSourceChunkPathsForFile(db, relativePath) : [];
    let writtenChunks: WrittenSourceChunk[] = [];
    if (lorePath && symbols.length > 0) {
      try {
        writtenChunks = await writeSourceChunkFilesForSymbols(
          lorePath,
          relativePath,
          language,
          symbols,
          content,
        );
      } catch {
        continue;
      }
    }

    db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      const savedBindings = existing ? saveBindingsForSourceFile(db, existing.id) : new Map();
      if (existing) {
        deleteSourceChunksForFile(db, relativePath);
        deleteSymbolsForSourceFile(db, existing.id);
        deleteCallSitesForSourceFile(db, existing.id);
      }

      const sourceFile = upsertSourceFile(db, {
        filePath: relativePath,
        language,
        contentHash,
        sizeBytes: stat.size,
        symbolCount: symbols.length,
      });

      if (symbols.length > 0) {
        const symbolOpts = symbols.map((s) => ({
          sourceFileId: sourceFile.id,
          name: s.name,
          qualifiedName: s.qualified_name,
          kind: s.kind as SymbolKind,
          parentId: null as string | null,
          lineStart: s.line_start,
          lineEnd: s.line_end,
          signature: s.signature,
          bodyHash: s.body_hash,
          exportStatus: s.export_status,
        }));
        insertSymbolBatch(db, sourceFile.id, relativePath, symbolOpts);
      }

      rematchBindings(db, savedBindings, sourceFile.id, content);

      insertSourceChunks(db, relativePath, writtenChunks);

      if (callSites.length > 0) {
        insertCallSiteBatch(
          db,
          sourceFile.id,
          callSites.map((cs) => ({
            callee_name: cs.callee_name,
            caller_name: cs.caller_context === "<module>" ? null : cs.caller_context,
            line: cs.line,
            snippet: cs.snippet,
          })),
        );
      }

      db.run("COMMIT");
    } catch (err) {
      db.run("ROLLBACK");
      await cleanupChunkFiles(writtenChunks.map((chunk) => chunk.filePath));
      continue;
    }

    if (oldPaths.length > 0) {
      await cleanupChunkFiles(oldPaths);
    }

    rescanned++;
    symbolsFound += symbols.length;
  }

  return { rescanned, symbolsFound };
}

export async function rescanProject(
  db: Database,
  codePath: string,
  lorePath?: string,
): Promise<ScanResult> {
  // rescanProject is the same as scanProject — incremental by design
  // (it skips files whose content_hash hasn't changed)
  return scanProject(db, codePath, lorePath);
}
