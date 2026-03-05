import type { Database } from "bun:sqlite";
import type { SymbolRow, LoreConfig } from "@/types/index.ts";
import {
  deleteBindingsForConcept,
  upsertConceptSymbol,
  getFilesForConcept,
  pruneOrphanedBindings as pruneOrphanedBindingsDb,
} from "@/db/concept-symbols.ts";
import { getChunk } from "@/db/chunks.ts";
import { insertSymbolEmbedding } from "@/db/embeddings.ts";
import { getConcept, getActiveConcepts } from "@/db/concepts.ts";
import { readChunk } from "@/storage/chunk-reader.ts";
import { Embedder } from "./embedder.ts";
import { cosineDistance } from "./residuals.ts";
import { readSymbolContent } from "./git.ts";
import { mkdirSync, appendFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { ulid } from "ulid";

const SEMANTIC_BIND_BATCH_SIZE = 32;
const SEMANTIC_DISTANCE_THRESHOLD = 0.60; // distance ≤ this → bind
const SEMANTIC_MAX_PER_CONCEPT = 30; // max symbol bindings per concept

export interface BindingExtractionResult {
  bound: number;
  byType: { ref: number; mention: number };
}

export interface AutoBindResult {
  concepts_processed: number;
  files_matched: number;
  symbols_bound: number;
  skipped_existing: number;
  log_path: string;
}

/**
 * Get all symbols from the database with their file paths.
 * Returns a map of symbol name → SymbolRow[] for efficient lookup.
 */
function getAllSymbolsByName(db: Database): Map<string, Array<SymbolRow & { file_path: string }>> {
  const rows = db
    .query<SymbolRow & { file_path: string }, []>(
      `SELECT s.*, sf.file_path
       FROM symbols s
       JOIN source_files sf ON s.source_file_id = sf.id`,
    )
    .all();

  const byName = new Map<string, Array<SymbolRow & { file_path: string }>>();
  for (const row of rows) {
    const existing = byName.get(row.name);
    if (existing) {
      existing.push(row);
    } else {
      byName.set(row.name, [row]);
    }
  }
  return byName;
}

/**
 * Extract symbol bindings for a set of concepts.
 * Zero LLM calls — uses name mention matching against all scanned symbols.
 */
export async function extractBindingsForConcepts(
  db: Database,
  conceptIds: string[],
): Promise<BindingExtractionResult> {
  let totalBound = 0;
  let mentionCount = 0;

  // Build name→symbol map once for all concepts
  const symbolsByName = getAllSymbolsByName(db);

  for (const conceptId of conceptIds) {
    const concept = getConcept(db, conceptId);
    if (!concept || !concept.active_chunk_id) continue;

    // Read concept content
    const chunkRow = getChunk(db, concept.active_chunk_id);
    if (!chunkRow) continue;

    let conceptContent: string;
    try {
      const parsed = await readChunk(chunkRow.file_path);
      conceptContent = parsed.content;
    } catch {
      continue;
    }

    if (!conceptContent) continue;

    // Clean slate for this concept
    deleteBindingsForConcept(db, conceptId);

    // Word-boundary match symbol names against concept content
    for (const [symbolName, symbols] of symbolsByName) {
      // Skip very short names to avoid false positives
      if (symbolName.length < 3) continue;

      const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const re = new RegExp(`\\b${escaped}\\b`);
      if (!re.test(conceptContent)) continue;

      // Bind all symbols with this name (may be in multiple files)
      for (const symbol of symbols) {
        upsertConceptSymbol(db, {
          conceptId,
          symbolId: symbol.id,
          bindingType: "mention",
          boundBodyHash: symbol.body_hash,
          confidence: 0.5,
        });
        mentionCount++;
        totalBound++;
      }
    }
  }

  return { bound: totalBound, byType: { ref: 0, mention: mentionCount } };
}

/**
 * Auto-bind using code embedding similarity.
 *
 * For each active concept:
 *   1. Embed the concept's prose via the code model (voyage-code-3).
 *   2. Compare against all symbol embeddings in `symbol_embeddings` (pre-populated
 *      by `lore mind embeddings refresh`, or computed here on the fly if missing).
 *   3. Bind the top-N symbols with cosine distance ≤ SEMANTIC_DISTANCE_THRESHOLD,
 *      setting confidence = min(0.85, 1 − distance) instead of a hardcoded value.
 *
 * Falls back to `autoBindByFileOverlap` if no code model is configured.
 */
export async function autoBindSemantic(
  db: Database,
  config: LoreConfig,
  codePath: string,
  opts?: { conceptIds?: string[] },
): Promise<AutoBindResult> {
  // Fall back to heuristic if code model not configured
  const codeEmbedder = await Embedder.createForCode(config);
  if (!codeEmbedder) {
    return autoBindByFileOverlap(db, opts);
  }
  const codeModel = config.ai.embedding.code!.model;

  // Diagnostic log
  const logDir = join(homedir(), ".lore", "logs");
  mkdirSync(logDir, { recursive: true });
  const logId = ulid();
  const logPath = join(logDir, `${logId}.jsonl`);
  const log = (entry: Record<string, unknown>) => {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  };

  // 1. Load all symbols from DB with file path + line info
  type SymbolWithPath = {
    id: string;
    name: string;
    body_hash: string | null;
    line_start: number;
    line_end: number;
    file_path: string;
  };
  const allSymbols = db
    .query<SymbolWithPath, []>(
      `SELECT s.id, s.name, s.body_hash, s.line_start, s.line_end, sf.file_path
       FROM symbols s
       JOIN source_files sf ON s.source_file_id = sf.id`,
    )
    .all();

  log({ type: "init", symbols: allSymbols.length, model: codeModel });

  // 2. Load existing symbol embeddings for this model from DB
  const symbolVecs = new Map<string, Float32Array>();
  const existingRows = db
    .query<{ symbol_id: string; embedding: Uint8Array }, [string]>(
      `SELECT symbol_id, embedding FROM symbol_embeddings WHERE model = ?`,
    )
    .all(codeModel);
  for (const r of existingRows) {
    symbolVecs.set(r.symbol_id, new Float32Array(r.embedding.buffer));
  }

  log({ type: "cache", cached: symbolVecs.size, missing: allSymbols.length - symbolVecs.size });

  // 3. Embed symbols not yet in DB (on-the-fly if embeddings refresh hasn't run)
  const toEmbed = allSymbols.filter((s) => !symbolVecs.has(s.id));
  const withContent: Array<{ id: string; content: string }> = [];
  for (const sym of toEmbed) {
    const content = await readSymbolContent(codePath, sym.file_path, sym.line_start, sym.line_end);
    if (content) withContent.push({ id: sym.id, content });
  }
  for (let i = 0; i < withContent.length; i += SEMANTIC_BIND_BATCH_SIZE) {
    const batch = withContent.slice(i, i + SEMANTIC_BIND_BATCH_SIZE);
    try {
      const vecs = await codeEmbedder.embedBatch(batch.map((s) => s.content));
      for (let j = 0; j < batch.length; j++) {
        const vec = vecs[j]!;
        symbolVecs.set(batch[j]!.id, vec);
        insertSymbolEmbedding(db, batch[j]!.id, vec, codeModel);
      }
    } catch {
      // non-fatal — partial embedding degrades gracefully
    }
  }

  log({ type: "embedded", total_vecs: symbolVecs.size });

  // 4. Get concepts to process
  const concepts = opts?.conceptIds
    ? opts.conceptIds.map((id) => getConcept(db, id)).filter(Boolean)
    : getActiveConcepts(db);

  let conceptsProcessed = 0;
  let symbolsBound = 0;
  let skippedExisting = 0;

  for (const concept of concepts) {
    if (!concept || !concept.active_chunk_id) continue;
    conceptsProcessed++;

    // Read concept prose
    const chunkRow = getChunk(db, concept.active_chunk_id);
    if (!chunkRow) continue;
    let conceptContent: string;
    try {
      const parsed = await readChunk(chunkRow.file_path);
      conceptContent = parsed.content;
    } catch {
      continue;
    }
    if (!conceptContent) continue;

    // Embed concept via code model
    let conceptVec: Float32Array;
    try {
      conceptVec = await codeEmbedder.embed(conceptContent);
    } catch {
      continue;
    }

    // Skip symbols with protected bindings (confidence >= 0.9, e.g. manual ref bindings)
    const protectedIds = new Set(
      db
        .query<{ symbol_id: string }, [string, number]>(
          `SELECT symbol_id FROM concept_symbols WHERE concept_id = ? AND confidence >= ?`,
        )
        .all(concept.id, 0.9)
        .map((r) => r.symbol_id),
    );
    skippedExisting += protectedIds.size;

    // Score all symbols and collect candidates below threshold
    const candidates: Array<{ symbolId: string; distance: number; bodyHash: string | null }> = [];
    for (const sym of allSymbols) {
      if (protectedIds.has(sym.id)) continue;
      const symVec = symbolVecs.get(sym.id);
      if (!symVec) continue;
      const dist = cosineDistance(conceptVec, symVec);
      if (dist <= SEMANTIC_DISTANCE_THRESHOLD) {
        candidates.push({ symbolId: sym.id, distance: dist, bodyHash: sym.body_hash });
      }
    }

    // Take top-N by ascending distance
    candidates.sort((a, b) => a.distance - b.distance);
    const toBind = candidates.slice(0, SEMANTIC_MAX_PER_CONCEPT);

    for (const c of toBind) {
      upsertConceptSymbol(db, {
        conceptId: concept.id,
        symbolId: c.symbolId,
        bindingType: "mention",
        boundBodyHash: c.bodyHash,
        confidence: Math.min(0.85, 1 - c.distance),
      });
      symbolsBound++;
    }

    log({
      type: "concept",
      concept: concept.name,
      candidates: candidates.length,
      bound: toBind.length,
      skipped_protected: protectedIds.size,
    });
  }

  const result: AutoBindResult = {
    concepts_processed: conceptsProcessed,
    files_matched: 0, // N/A for semantic binding
    symbols_bound: symbolsBound,
    skipped_existing: skippedExisting,
    log_path: logPath,
  };

  log({ type: "summary", ...result, log_id: logId });
  return result;
}

/**
 * Auto-bind by file overlap: for each concept, look at which files its
 * already-bound symbols live in, then bind ALL other exported symbols
 * from those same files at confidence 0.8.
 *
 * Runs AFTER extractBindingsForConcepts (which creates mention bindings at 0.5).
 * This upgrades existing mention bindings to 0.8 and adds sibling exports.
 * Does not touch bindings with confidence >= 0.9 (manual/protected).
 *
 * Writes a diagnostic log to ~/.lore/logs/<ULID>.jsonl
 */
export async function autoBindByFileOverlap(
  db: Database,
  opts?: { conceptIds?: string[] },
): Promise<AutoBindResult> {
  // Set up diagnostic log
  const logDir = join(homedir(), ".lore", "logs");
  mkdirSync(logDir, { recursive: true });
  const logId = ulid();
  const logPath = join(logDir, `${logId}.jsonl`);
  const log = (entry: Record<string, unknown>) => {
    appendFileSync(logPath, JSON.stringify(entry) + "\n");
  };

  // Get concepts to process
  const concepts = opts?.conceptIds
    ? opts.conceptIds.map((id) => getConcept(db, id)).filter(Boolean)
    : getActiveConcepts(db);

  log({
    type: "init",
    concept_count: concepts.length,
    scoped_to_concept_ids: opts?.conceptIds ?? null,
  });

  let conceptsProcessed = 0;
  const allMatchedFiles = new Set<string>();
  let symbolsBound = 0;
  let skippedExisting = 0;

  for (const concept of concepts) {
    if (!concept) continue;
    conceptsProcessed++;

    // Get files from already-bound symbols
    const boundFiles = getFilesForConcept(db, concept.id);
    if (boundFiles.length === 0) {
      log({ type: "concept", concept: concept.name, bound_files: 0, exported: 0, bound: 0, skipped_protected: 0 });
      continue;
    }

    for (const f of boundFiles) allMatchedFiles.add(f);

    // Get all exported symbols from those files
    const placeholders = boundFiles.map(() => "?").join(",");
    const exportedSymbols = db
      .query<
        { id: string; body_hash: string | null; name: string },
        string[]
      >(
        `SELECT s.id, s.body_hash, s.name FROM symbols s
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE sf.file_path IN (${placeholders})
         AND s.export_status IN ('exported', 'default_export')`,
      )
      .all(...boundFiles);

    if (exportedSymbols.length === 0) {
      log({ type: "concept", concept: concept.name, bound_files: boundFiles.length, exported: 0, bound: 0, skipped_protected: 0 });
      continue;
    }

    // Get protected bindings (confidence >= 0.9) to skip
    const protectedIds = new Set(
      db
        .query<{ symbol_id: string }, [string, number]>(
          `SELECT symbol_id FROM concept_symbols WHERE concept_id = ? AND confidence >= ?`,
        )
        .all(concept.id, 0.9)
        .map((r) => r.symbol_id),
    );

    let conceptBound = 0;
    let conceptSkipped = 0;

    for (const sym of exportedSymbols) {
      if (protectedIds.has(sym.id)) {
        conceptSkipped++;
        skippedExisting++;
        continue;
      }
      upsertConceptSymbol(db, {
        conceptId: concept.id,
        symbolId: sym.id,
        bindingType: "mention",
        boundBodyHash: sym.body_hash,
        confidence: 0.8,
      });
      conceptBound++;
      symbolsBound++;
    }

    log({
      type: "concept",
      concept: concept.name,
      bound_files: boundFiles.length,
      files: boundFiles,
      exported: exportedSymbols.length,
      bound: conceptBound,
      skipped_protected: conceptSkipped,
    });
  }

  const result: AutoBindResult = {
    concepts_processed: conceptsProcessed,
    files_matched: allMatchedFiles.size,
    symbols_bound: symbolsBound,
    skipped_existing: skippedExisting,
    log_path: logPath,
  };

  log({ type: "summary", ...result, log_id: logId });

  return result;
}

export function pruneOrphanedBindings(db: Database): number {
  return pruneOrphanedBindingsDb(db);
}
