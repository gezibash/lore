import type { Database } from "bun:sqlite";
import type { ConceptSymbolLineRange } from "@/db/concept-symbols.ts";
import { insertSymbolEmbeddingBatch } from "@/db/index.ts";
import type { Embedder } from "./embedder.ts";
import { readSymbolContent } from "./git.ts";
import { cosineDistance, weightedAverageVectors } from "./residuals.ts";
import { mapConcurrent } from "./async.ts";

/**
 * e_embed (knowledge-model spec §3.1): the cosine distance between a concept's
 * prose and the confidence-weighted centroid of its bound symbols' bodies.
 * One implementation, shared by close maintenance and heal, so the two can
 * never disagree about what "the prose matches the code" means.
 *
 * Code embedder preferred, text embedder fallback (spec §8). Returns null for
 * a concept whose e_embed cannot be measured — no code path, no bound
 * symbols, no embeddings. A null is a measurement gap and must be surfaced as
 * one, never replaced by churn or 0.
 */

export function loadSymbolLinesByConceptIds(
  db: Database,
  conceptIds: readonly string[],
): Map<string, ConceptSymbolLineRange[]> {
  const grouped = new Map<string, ConceptSymbolLineRange[]>();
  if (conceptIds.length === 0) return grouped;

  let rows: Array<ConceptSymbolLineRange & { concept_id: string }> = [];
  try {
    const placeholders = conceptIds.map(() => "?").join(", ");
    rows = db
      .query<ConceptSymbolLineRange & { concept_id: string }, string[]>(
        `SELECT cs.concept_id, cs.symbol_id, sf.file_path, s.name AS symbol_name, s.qualified_name, s.kind,
                s.line_start, s.line_end, s.signature, cs.confidence
         FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id IN (${placeholders})
         ORDER BY cs.concept_id, sf.file_path, s.line_start`,
      )
      .all(...conceptIds);
  } catch {
    return grouped;
  }

  for (const row of rows) {
    const list = grouped.get(row.concept_id);
    const lineRange: ConceptSymbolLineRange = {
      symbol_id: row.symbol_id,
      file_path: row.file_path,
      symbol_name: row.symbol_name,
      qualified_name: row.qualified_name,
      kind: row.kind,
      line_start: row.line_start,
      line_end: row.line_end,
      signature: row.signature,
      confidence: row.confidence,
    };
    if (list) list.push(lineRange);
    else grouped.set(row.concept_id, [lineRange]);
  }

  return grouped;
}

export interface GroundResidualTarget {
  conceptId: string;
  /** The concept's current prose. */
  content: string;
  /** The prose's text-model embedding, if already on hand (fallback lane). */
  textEmbedding: Float32Array | null;
}

export async function measureGroundResiduals(
  db: Database,
  opts: {
    codePath: string | null;
    targets: GroundResidualTarget[];
    embedder: Embedder;
    codeEmbedder?: Embedder | null;
    codeModel?: string | null;
  },
): Promise<Map<string, number | null>> {
  const result = new Map<string, number | null>(opts.targets.map((t) => [t.conceptId, null]));
  if (!opts.codePath || opts.targets.length === 0) return result;
  const codePath = opts.codePath;
  const conceptIds = opts.targets.map((t) => t.conceptId);

  const symbolLinesByConceptId = loadSymbolLinesByConceptIds(db, conceptIds);
  const symbolReadTargets = new Map<
    string,
    { file_path: string; line_start: number; line_end: number }
  >();
  for (const symbolLines of symbolLinesByConceptId.values()) {
    for (const sym of symbolLines) {
      if (!symbolReadTargets.has(sym.symbol_id)) {
        symbolReadTargets.set(sym.symbol_id, {
          file_path: sym.file_path,
          line_start: sym.line_start,
          line_end: sym.line_end,
        });
      }
    }
  }
  if (symbolReadTargets.size === 0) return result;

  const symbolReads = await mapConcurrent(
    [...symbolReadTargets.entries()],
    8,
    async ([symbolId, target]) => ({
      symbolId,
      content: await readSymbolContent(
        codePath,
        target.file_path,
        target.line_start,
        target.line_end,
      ),
    }),
  );
  const symbolContentEntries = symbolReads
    .filter((read): read is { symbolId: string; content: string } => !!read.content)
    .map((read) => ({ symbolId: read.symbolId, content: read.content }));
  if (symbolContentEntries.length === 0) return result;

  const conceptCodeEmbeddingsByConceptId = new Map<string, Float32Array>();
  const symbolCodeEmbeddingsById = new Map<string, Float32Array>();
  const symbolTextEmbeddingsById = new Map<string, Float32Array>();

  if (opts.codeEmbedder && opts.codeModel) {
    const codeModel = opts.codeModel;
    try {
      const codeEmbeddings = await opts.codeEmbedder.embedBatch([
        ...opts.targets.map((target) => target.content),
        ...symbolContentEntries.map((entry) => entry.content),
      ]);
      for (let i = 0; i < opts.targets.length; i++) {
        conceptCodeEmbeddingsByConceptId.set(opts.targets[i]!.conceptId, codeEmbeddings[i]!);
      }
      const symbolOffset = opts.targets.length;
      const symbolEmbeddingWrites: Array<{
        symbolId: string;
        embedding: Float32Array;
        model: string;
      }> = [];
      for (let i = 0; i < symbolContentEntries.length; i++) {
        const embedding = codeEmbeddings[symbolOffset + i]!;
        symbolCodeEmbeddingsById.set(symbolContentEntries[i]!.symbolId, embedding);
        symbolEmbeddingWrites.push({
          symbolId: symbolContentEntries[i]!.symbolId,
          embedding,
          model: codeModel,
        });
      }
      insertSymbolEmbeddingBatch(db, symbolEmbeddingWrites);
    } catch {
      // Non-fatal: fall back to the text lane below.
    }
  }

  const needsTextLane = opts.targets.some(
    (target) => !conceptCodeEmbeddingsByConceptId.has(target.conceptId) && target.textEmbedding,
  );
  if (needsTextLane) {
    try {
      const symbolTextEmbeddings = await opts.embedder.embedBatch(
        symbolContentEntries.map((entry) => entry.content),
      );
      for (let i = 0; i < symbolContentEntries.length; i++) {
        symbolTextEmbeddingsById.set(symbolContentEntries[i]!.symbolId, symbolTextEmbeddings[i]!);
      }
    } catch {
      // Non-fatal.
    }
  }

  const centroid = (
    symbolLines: ConceptSymbolLineRange[],
    embeddingsById: Map<string, Float32Array>,
  ): Float32Array | null => {
    const grounding = symbolLines
      .map((sym) => {
        const embedding = embeddingsById.get(sym.symbol_id);
        return embedding ? { embedding, confidence: sym.confidence } : null;
      })
      .filter((item): item is { embedding: Float32Array; confidence: number } => item != null);
    if (grounding.length === 0) return null;
    return weightedAverageVectors(
      grounding.map((item) => item.embedding),
      grounding.map((item) => item.confidence),
    );
  };

  for (const target of opts.targets) {
    const symbolLines = symbolLinesByConceptId.get(target.conceptId) ?? [];
    const conceptCodeEmbedding = conceptCodeEmbeddingsByConceptId.get(target.conceptId);
    const codeCentroid = conceptCodeEmbedding
      ? centroid(symbolLines, symbolCodeEmbeddingsById)
      : null;
    if (conceptCodeEmbedding && codeCentroid) {
      result.set(target.conceptId, cosineDistance(conceptCodeEmbedding, codeCentroid));
      continue;
    }
    if (target.textEmbedding) {
      const textCentroid = centroid(symbolLines, symbolTextEmbeddingsById);
      if (textCentroid) {
        result.set(target.conceptId, cosineDistance(target.textEmbedding, textCentroid));
      }
    }
  }
  return result;
}
