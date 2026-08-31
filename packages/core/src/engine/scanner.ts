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
import { discoverFiles, isTsxFile, languageForPath } from "./file-discovery.ts";
import { mapConcurrent } from "./async.ts";
import { GrammarLoadError, TreeSitterPool } from "./tree-sitter.ts";
import { extractSymbols, extractCallSites } from "./symbol-queries.ts";
import { expandCamelCase } from "@/db/symbols.ts";
import {
  upsertSourceFile,
  getSourceFileByPath,
  getAllSourceFiles,
  deleteSourceFile,
} from "@/db/source-files.ts";
import {
  insertSymbolBatch,
  deleteSymbolsForSourceFile,
  getSymbolsForSourceFile,
} from "@/db/symbols.ts";
import { insertCallSiteBatch, deleteCallSitesForSourceFile } from "@/db/call-sites.ts";
import { getBindingsForSymbol, upsertConceptSymbol } from "@/db/concept-symbols.ts";
import {
  insertChunkBatch,
  getSourceChunkPathsForFile,
  deleteSourceChunksForFile,
} from "@/db/chunks.ts";
import { insertFtsContentBatch } from "@/db/fts.ts";
import { writeSourceChunk, deleteSourceChunkFile } from "@/storage/chunk-writer.ts";

const SCAN_PREPARE_CONCURRENCY = 4;

// ─── Shared helpers ───────────────────────────────────────────────────────────

/** Positional key for a symbol — stable across a re-qualification, unlike qualified_name. */
function symbolPositionKey(name: string, lineStart: number | null): string {
  return `${name}@${lineStart ?? -1}`;
}

/** Snapshot all binding associations for a source file, keyed by qualified_name *and* by
 *  (name, line_start). Call before deleting old symbol rows so bindings can be rematched
 *  after re-insert. The positional key is the fallback for the case where a symbol keeps its
 *  identity but changes qualified_name — e.g. when a scanner change starts qualifying Python
 *  methods as `Class.method` — which would otherwise drop every binding on a method. */
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
      const entry = bindings.map((b) => ({
        concept_id: b.concept_id,
        binding_type: b.binding_type,
        confidence: b.confidence,
      }));
      saved.set(sym.qualified_name, entry);
      saved.set(symbolPositionKey(sym.name, sym.line_start), entry);
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
    const oldBindings =
      saved.get(sym.qualified_name) ?? saved.get(symbolPositionKey(sym.name, sym.line_start));
    if (!oldBindings) continue;
    const boundBody =
      contentLines && sym.line_start != null && sym.line_end != null
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

/** "packages/core/src/engine/scanner.ts" -> "packages core src engine scanner ts" */
function pathWords(sourceFile: string): string {
  return sourceFile.replace(/[/._-]+/g, " ");
}

interface WrittenSourceChunk {
  id: string;
  filePath: string;
  body: string;
  symbol: string;
}

async function cleanupChunkFiles(filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map((filePath) => deleteSourceChunkFile(filePath)));
}

/** A line that carries only a comment. One predicate covers every supported
 *  language: `//`, `///`, `//!` (ts/js/go/rust), `#` (python/elixir), and the
 *  `/* ... *\/` block forms including continuation lines starting with `*`. */
function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0) return false;
  return (
    trimmed.startsWith("//") ||
    trimmed.startsWith("#") ||
    trimmed.startsWith("/*") ||
    trimmed.startsWith("*")
  );
}

/** First line of the comment block documenting the symbol that starts at
 *  `symbolStart`, or `symbolStart` when there is none.
 *
 *  Tree-sitter reports a declaration's range without its leading comment, so
 *  the comment would otherwise land in a neighbouring module gap chunk. That
 *  split is not cosmetic: a comment reading "only reconciled when explicitly
 *  marked as schema-only" retrieved *without* the allowlist it describes reads
 *  as evidence that no allowlist exists. A blank line ends the block — a
 *  detached comment above a blank line documents the file, not the symbol. */
function leadingCommentStart(
  contentLines: string[],
  symbolStart: number,
  claimed: Uint8Array,
): number {
  let start = symbolStart;
  for (let line = symbolStart - 1; line >= 1; line--) {
    if (claimed[line] === 1) break;
    const text = contentLines[line - 1];
    if (text === undefined || !isCommentLine(text)) break;
    start = line;
  }
  return start;
}

/** Contiguous line ranges of the file not covered by any emitted chunk.
 *  Module-level code lives here: constants, top-level config, bare statements.
 *  Without these, a value like `DEFAULT_LIMITS = Limits(max_connections=100)`
 *  sitting below the last class is invisible to retrieval entirely. */
function uncoveredRanges(
  claimedRanges: Array<{ start: number; end: number }>,
  totalLines: number,
): Array<{ start: number; end: number }> {
  const covered = new Uint8Array(totalLines + 1);
  for (const range of claimedRanges) {
    for (let line = range.start; line <= Math.min(range.end, totalLines); line++) {
      covered[line] = 1;
    }
  }
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  for (let line = 1; line <= totalLines + 1; line++) {
    const isCovered = line > totalLines || covered[line] === 1;
    if (!isCovered && start === 0) start = line;
    if (isCovered && start !== 0) {
      ranges.push({ start, end: line - 1 });
      start = 0;
    }
  }
  return ranges;
}

/** Write one source chunk file per symbol, plus one per uncovered module-level
 *  region. Returns the staged files for later DB insertion. */
async function writeSourceChunkFilesForSymbols(
  lorePath: string,
  sourceFile: string,
  language: SupportedLanguage,
  symbols: SymbolForChunk[],
  content: string,
): Promise<WrittenSourceChunk[]> {
  const written: WrittenSourceChunk[] = [];
  const contentLines = content.split("\n");

  // Claim symbol bodies first, then grow each one upward over its doc comment.
  // Two passes so a comment already inside another symbol is never stolen.
  const claimed = new Uint8Array(contentLines.length + 1);
  for (const sym of symbols) {
    for (let line = sym.line_start; line <= Math.min(sym.line_end, contentLines.length); line++) {
      claimed[line] = 1;
    }
  }
  const chunkRanges = symbols.map((sym) => ({
    sym,
    start: leadingCommentStart(contentLines, sym.line_start, claimed),
    end: sym.line_end,
  }));
  for (const range of chunkRanges) {
    for (let line = range.start; line < range.sym.line_start; line++) claimed[line] = 1;
  }

  try {
    for (const { sym, start, end } of chunkRanges) {
      const body = contentLines.slice(start - 1, end).join("\n");
      const { id, filePath } = await writeSourceChunk({
        lorePath,
        sourceFile,
        lineStart: start,
        lineEnd: end,
        symbol: sym.qualified_name,
        kind: sym.kind as SymbolKind,
        language,
        // The symbol's own hash, not the chunk text's: a reworded comment is
        // not implementation drift and must not invalidate bindings.
        bodyHash: sym.body_hash,
        body,
      });
      written.push({ id, filePath, body, symbol: sym.qualified_name });
    }

    for (const range of uncoveredRanges(chunkRanges, contentLines.length)) {
      const body = contentLines
        .slice(range.start - 1, range.end)
        .join("\n")
        .trim();
      if (body.length === 0) continue;
      const { id, filePath } = await writeSourceChunk({
        lorePath,
        sourceFile,
        lineStart: range.start,
        lineEnd: range.end,
        symbol: `__module__:${range.start}`,
        kind: "module",
        language,
        bodyHash: null,
        body,
      });
      written.push({ id, filePath, body, symbol: `${sourceFile} module scope` });
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
  // Index the file path and symbol name alongside the body. A code body rarely
  // contains the words a person searches by — nothing in scanner.ts says
  // "scanner" — so without this header the most natural query for a file cannot
  // reach it by keyword at all. camelCase is split so "file discovery" matches
  // fileDiscovery.
  insertFtsContentBatch(
    db,
    chunks.map((chunk) => ({
      content: `${sourceFile} ${expandCamelCase(pathWords(sourceFile))} ${chunk.symbol} ${expandCamelCase(chunk.symbol)}\n${chunk.body}`,
      chunkId: chunk.id,
    })),
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
  force = false,
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

  if (!force && existing && existing.content_hash === contentHash) {
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
    try {
      symbols = extractSymbols(tree, lang, file.language, content, pool);
      callSites = extractCallSites(tree, lang, file.language, content, pool);
    } finally {
      tree.delete();
    }
  } catch (error) {
    // A missing grammar condemns every file of its language, so reporting it as
    // one more failed file hides it behind a scan that simply found nothing.
    if (error instanceof GrammarLoadError) throw error;
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
    const insertedCount = insertSourceChunks(
      db,
      prepared.file.relativePath,
      prepared.writtenChunks,
    );
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
          parentName: symbol.parent_name,
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
  opts?: { force?: boolean },
): Promise<ScanResult> {
  const start = performance.now();
  const files = discoverFiles(codePath);
  // force: ignore the content-hash gate so every file re-chunks. Needed after a
  // change to how chunks are produced or indexed, which unchanged files would
  // otherwise never pick up. The existing rows must still be loaded — they are
  // what drives deletion of the superseded chunks, symbols and call sites, so
  // hiding them makes every file look new and the index duplicates every run.
  const existingByPath = new Map(getAllSourceFiles(db).map((file) => [file.file_path, file]));

  const pool = new TreeSitterPool();
  await pool.init();
  try {
    return await scanWithPool(db, codePath, pool, files, existingByPath, start, lorePath, opts);
  } finally {
    // web-tree-sitter never collects a grammar. A pool per scan without this
    // grows the wasm heap of a long-lived daemon on every close and every heal.
    await pool.dispose();
  }
}

async function scanWithPool(
  db: Database,
  codePath: string,
  pool: TreeSitterPool,
  files: DiscoveredFile[],
  existingByPath: Map<string, SourceFileRow>,
  start: number,
  lorePath?: string,
  opts?: { force?: boolean },
): Promise<ScanResult> {
  const currentPaths = new Set(files.map((file) => file.relativePath));
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
    (file) => prepareSourceScanFile(db, pool, lorePath, file, existingByPath, opts?.force),
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
): Promise<{ rescanned: number; symbolsFound: number; filesFailed: string[] }> {
  if (filePaths.length === 0) return { rescanned: 0, symbolsFound: 0, filesFailed: [] };

  const pool = new TreeSitterPool();
  await pool.init();
  try {
    return await rescanWithPool(db, codePath, pool, filePaths, lorePath);
  } finally {
    await pool.dispose();
  }
}

async function rescanWithPool(
  db: Database,
  codePath: string,
  pool: TreeSitterPool,
  filePaths: string[],
  lorePath?: string,
): Promise<{ rescanned: number; symbolsFound: number; filesFailed: string[] }> {
  let rescanned = 0;
  let symbolsFound = 0;
  // A dropped file keeps serving its previous chunks: indistinguishable from
  // "unchanged" unless the caller is told. Mirrors scanProject's files_failed.
  const filesFailed: string[] = [];

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
      filesFailed.push(relativePath);
      continue;
    }

    const contentHash = createHash("sha256").update(content).digest("hex");

    const existing = getSourceFileByPath(db, relativePath);
    if (existing && existing.content_hash === contentHash) {
      symbolsFound += existing.symbol_count;
      continue;
    }

    // The same mapping discoverFiles uses. A second copy here went stale when
    // Elixir was added, and every .ex file was dropped without a word.
    const language = languageForPath(relativePath);
    if (!language) {
      filesFailed.push(relativePath);
      continue;
    }

    const isTsx = isTsxFile(relativePath);
    let symbols: ExtractedSymbol[];
    let callSites: ExtractedCallSite[] = [];
    try {
      const { tree, lang } = await pool.parse(content, language, isTsx);
      try {
        symbols = extractSymbols(tree, lang, language, content, pool);
        callSites = extractCallSites(tree, lang, language, content, pool);
      } finally {
        tree.delete();
      }
    } catch (error) {
      if (error instanceof GrammarLoadError) throw error;
      filesFailed.push(relativePath);
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
          parentName: s.parent_name,
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
    } catch {
      db.run("ROLLBACK");
      await cleanupChunkFiles(writtenChunks.map((chunk) => chunk.filePath));
      filesFailed.push(relativePath);
      continue;
    }

    if (oldPaths.length > 0) {
      await cleanupChunkFiles(oldPaths);
    }

    rescanned++;
    symbolsFound += symbols.length;
  }

  return { rescanned, symbolsFound, filesFailed };
}

export async function rescanProject(
  db: Database,
  codePath: string,
  lorePath?: string,
  opts?: { force?: boolean },
): Promise<ScanResult> {
  // rescanProject is the same as scanProject — incremental by design
  // (it skips files whose content_hash hasn't changed) unless force is set.
  return scanProject(db, codePath, lorePath, opts);
}
