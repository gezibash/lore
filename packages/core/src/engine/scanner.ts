import type { Database } from "bun:sqlite";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import type { ScanResult, SymbolKind, ExtractedSymbol, BindingType, SupportedLanguage } from "@/types/index.ts";
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

/** Write one source chunk per symbol to disk and register it in the DB. Returns count written. */
async function writeSourceChunksForSymbols(
  db: Database,
  lorePath: string,
  sourceFile: string,
  language: SupportedLanguage,
  symbols: SymbolForChunk[],
  content: string,
): Promise<number> {
  if (symbols.length === 0) return 0;
  let count = 0;
  const contentLines = content.split("\n");
  for (const sym of symbols) {
    const body = contentLines.slice(sym.line_start - 1, sym.line_end).join("\n");
    try {
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
      insertChunk(db, {
        id,
        filePath,
        flType: "source",
        createdAt: new Date().toISOString(),
        sourceFilePath: sourceFile,
      });
      insertFtsContent(db, body, id);
      count++;
    } catch {
      // Non-fatal: continue scanning remaining symbols
    }
  }
  return count;
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
          sourceChunksFound += await writeSourceChunksForSymbols(
            db, lorePath, file.relativePath, file.language, existingSymbols, content,
          );
        }
      }

      continue;
    }

    // Parse with tree-sitter
    const isTsx = isTsxFile(file.relativePath);
    let symbols: ExtractedSymbol[];
    let callSites: import("@/types/index.ts").ExtractedCallSite[] = [];
    try {
      const { tree, lang } = await pool.parse(content, file.language, isTsx);
      symbols = extractSymbols(tree, lang, file.language, content, pool);
      callSites = extractCallSites(tree, lang, file.language, content, pool);
      tree.delete();
    } catch {
      // Parse failure — store file with 0 symbols
      symbols = [];
    }

    // Delete old source chunks for this file before reinserting
    if (lorePath && existing) {
      const oldPaths = getSourceChunkPathsForFile(db, file.relativePath);
      deleteSourceChunksForFile(db, file.relativePath);
      for (const p of oldPaths) {
        await deleteSourceChunkFile(p);
      }
    }

    // Transactional update: delete old, insert new
    db.run("BEGIN TRANSACTION");
    try {
      // Save bindings before deleting old symbols so they can be rematched after re-insert
      const savedBindings = existing ? saveBindingsForSourceFile(db, existing.id) : new Map();
      if (existing) {
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
      throw err;
    }

    // Write source chunks for each symbol (outside transaction — async disk writes)
    if (lorePath) {
      sourceChunksFound += await writeSourceChunksForSymbols(
        db, lorePath, file.relativePath, file.language, symbols, content,
      );
    }

    filesScanned++;
    symbolsFound += symbols.length;
    callSitesFound += callSites.length;
    languages[file.language] = (languages[file.language] ?? 0) + symbols.length;
  }

  // Remove source files for files no longer on disk
  const allExisting = getAllSourceFiles(db);
  let filesRemoved = 0;
  for (const f of allExisting) {
    if (!currentPaths.has(f.file_path)) {
      if (lorePath) {
        const oldPaths = getSourceChunkPathsForFile(db, f.file_path);
        deleteSourceChunksForFile(db, f.file_path);
        for (const p of oldPaths) {
          await deleteSourceChunkFile(p);
        }
      }
      deleteSymbolsForSourceFile(db, f.id);
      deleteCallSitesForSourceFile(db, f.id);
      deleteSourceFile(db, f.id);
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
    let language: import("@/types/index.ts").SupportedLanguage;
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
    let callSites: import("@/types/index.ts").ExtractedCallSite[] = [];
    try {
      const { tree, lang } = await pool.parse(content, language, isTsx);
      symbols = extractSymbols(tree, lang, language, content, pool);
      callSites = extractCallSites(tree, lang, language, content, pool);
      tree.delete();
    } catch {
      symbols = [];
    }

    // Delete old source chunks for this file before reinserting
    if (lorePath && existing) {
      const oldPaths = getSourceChunkPathsForFile(db, relativePath);
      deleteSourceChunksForFile(db, relativePath);
      for (const p of oldPaths) {
        await deleteSourceChunkFile(p);
      }
    }

    db.run("BEGIN TRANSACTION");
    try {
      const savedBindings = existing ? saveBindingsForSourceFile(db, existing.id) : new Map();
      if (existing) {
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
      throw err;
    }

    // Write source chunks for each symbol
    if (lorePath) {
      await writeSourceChunksForSymbols(db, lorePath, relativePath, language, symbols, content);
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
