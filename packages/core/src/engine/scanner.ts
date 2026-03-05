import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { ScanResult, SymbolKind, ExtractedSymbol, BindingType, SupportedLanguage, ExtractedCallSite } from "@/types/index.ts";
import { discoverFiles, isTsxFile } from "./file-discovery.ts";
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
import { insertChunk, getSourceChunkPathsForFile, deleteSourceChunksForFile } from "@/db/chunks.ts";
import { insertFtsContent } from "@/db/index.ts";
import { writeSourceChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";

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
  for (const filePath of filePaths) {
    await deleteSourceChunkFile(filePath);
  }
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
  for (const chunk of chunks) {
    insertChunk(db, {
      id: chunk.id,
      filePath: chunk.filePath,
      flType: "source",
      createdAt: new Date().toISOString(),
      sourceFilePath: sourceFile,
    });
    insertFtsContent(db, chunk.body, chunk.id);
  }
  return chunks.length;
}

// ─── scanProject ─────────────────────────────────────────────────────────────

export async function scanProject(
  db: Database,
  codePath: string,
  lorePath?: string,
): Promise<ScanResult> {
  const start = performance.now();
  const files = discoverFiles(codePath);

  const pool = new TreeSitterPool();
  await pool.init();

  let filesScanned = 0;
  let filesSkipped = 0;
  let symbolsFound = 0;
  let callSitesFound = 0;
  let sourceChunksFound = 0;
  let filesFailed = 0;
  const languages: Record<string, number> = {};

  const currentPaths = new Set<string>();

  for (const file of files) {
    currentPaths.add(file.relativePath);

    let content: string;
    let stat: { size: number };
    try {
      content = readFileSync(file.absolutePath, "utf-8");
      stat = { size: Buffer.byteLength(content, "utf-8") };
    } catch {
      continue;
    }

    const contentHash = createHash("sha256").update(content).digest("hex");

    // Check if already scanned with same hash
    const existing = getSourceFileByPath(db, file.relativePath);
    if (existing && existing.content_hash === contentHash) {
      filesSkipped++;
      languages[file.language] = (languages[file.language] ?? 0) + existing.symbol_count;
      symbolsFound += existing.symbol_count;

      // Backfill source chunks for skipped files if lorePath provided and none exist yet
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
            let insertedCount = 0;
            db.run("BEGIN IMMEDIATE TRANSACTION");
            try {
              insertedCount = insertSourceChunks(db, file.relativePath, writtenChunks);
              db.run("COMMIT");
            } catch (error) {
              db.run("ROLLBACK");
              await cleanupChunkFiles(writtenChunks.map((chunk) => chunk.filePath));
              throw error;
            }
            sourceChunksFound += insertedCount;
          } catch {
            filesFailed++;
          }
        }
      }

      continue;
    }

    // Parse with tree-sitter
    const isTsx = isTsxFile(file.relativePath);
    let symbols: ExtractedSymbol[];
    let callSites: ExtractedCallSite[] = [];
    try {
      const { tree, lang } = await pool.parse(content, file.language, isTsx);
      symbols = extractSymbols(tree, lang, file.language, content, pool);
      callSites = extractCallSites(tree, lang, file.language, content, pool);
      tree.delete();
    } catch {
      filesFailed++;
      continue;
    }

    const oldPaths = lorePath && existing ? getSourceChunkPathsForFile(db, file.relativePath) : [];
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
        filesFailed++;
        continue;
      }
    }

    let insertedSourceChunks = 0;
    // Transactional update: insert replacement state before retiring the previous one.
    db.run("BEGIN IMMEDIATE TRANSACTION");
    try {
      // Save bindings before deleting old symbols so they can be rematched after re-insert
      const savedBindings = existing ? saveBindingsForSourceFile(db, existing.id) : new Map();
      if (existing) {
        deleteSourceChunksForFile(db, file.relativePath);
        deleteSymbolsForSourceFile(db, existing.id);
        deleteCallSitesForSourceFile(db, existing.id);
      }

      const sourceFile = upsertSourceFile(db, {
        filePath: file.relativePath,
        language: file.language,
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
        insertSymbolBatch(db, sourceFile.id, file.relativePath, symbolOpts);
      }

      rematchBindings(db, savedBindings, sourceFile.id, content);

      if (writtenChunks.length > 0) {
        insertedSourceChunks = insertSourceChunks(db, file.relativePath, writtenChunks);
      }

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
      filesFailed++;
      continue;
    }

    if (oldPaths.length > 0) {
      await cleanupChunkFiles(oldPaths);
    }

    filesScanned++;
    sourceChunksFound += insertedSourceChunks;
    symbolsFound += symbols.length;
    callSitesFound += callSites.length;
    languages[file.language] = (languages[file.language] ?? 0) + symbols.length;
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
 * but scoped to only the given files. Used during delta close to ensure symbol
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
