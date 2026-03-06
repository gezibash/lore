import type { Database } from "bun:sqlite";
import type {
  LoreConfig,
  RRFResult,
  SourceChunkFrontmatter,
  DocChunkFrontmatter,
} from "@/types/index.ts";
import { vectorSearch, getChunk, getConcept } from "@/db/index.ts";
import { bm25Search } from "@/db/fts.ts";
import { readChunk } from "@/storage/index.ts";
import { readSymbolContent } from "./git.ts";
import type { AskTracer } from "./tracer.ts";
import { mapConcurrent } from "./async.ts";

interface EmbedderLike {
  embed: (text: string) => Promise<Float32Array>;
}

/**
 * Reciprocal Rank Fusion: merges N ranked lists into one.
 * Standard algorithm: score(d) = Σ w_i/(k + rank(d)), rank is 0-indexed (top result = rank 0).
 * Per-lane weights default to 1.0. Empty lists are silently ignored.
 * Kept for BM25 / rank-only lane integration.
 */
export function reciprocalRankFusion(
  lists: Array<Array<{ chunkId: string }>>,
  k: number = 60,
  weights?: number[],
): RRFResult[] {
  const scores = new Map<string, number>();

  for (let listIdx = 0; listIdx < lists.length; listIdx++) {
    const list = lists[listIdx]!;
    const w = weights?.[listIdx] ?? 1.0;
    for (let i = 0; i < list.length; i++) {
      const id = list[i]!.chunkId;
      scores.set(id, (scores.get(id) ?? 0) + w / (k + i));
    }
  }

  return Array.from(scores.entries())
    .map(([chunkId, score]) => ({ chunkId, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Distance-priority merge: fuses results from multiple vector lanes by raw
 * cosine distance. Both text (qwen) and code (voyage) produce cosine distances
 * in [0,1] — a texty query will have tight text distances and loose code
 * distances, so the right lane wins naturally without explicit weights.
 *
 * Deduplicates by chunkId keeping the best (lowest) distance across lanes.
 * Returns results sorted by similarity (1 − distance) descending.
 */
export function mergeByDistance(
  ...lanes: Array<{ chunkId: string; distance: number }[]>
): RRFResult[] {
  const best = new Map<string, number>();
  for (const lane of lanes) {
    for (const { chunkId, distance } of lane) {
      const current = best.get(chunkId);
      if (current === undefined || distance < current) {
        best.set(chunkId, distance);
      }
    }
  }
  return Array.from(best.entries())
    .sort(([, a], [, b]) => a - b)
    .map(([chunkId, distance]) => ({ chunkId, score: 1 - distance }));
}

export interface HybridSearchResult {
  chunkId: string;
  score: number;
  content: string;
  concept?: string;
  warning?: string;
}

export interface HybridSearchRun {
  results: HybridSearchResult[];
  stats: {
    text_vector_candidates: number;
    code_vector_candidates: number;
    bm25_source_candidates: number;
    bm25_chunk_candidates: number;
    doc_vector_candidates: number;
    bm25_doc_candidates: number;
    fused_candidates: number;
  };
}

export async function hybridSearch(
  db: Database,
  embedder: EmbedderLike,
  query: string,
  config: LoreConfig,
  opts?: {
    sourceType?: "chunk" | "journal";
    limit?: number;
    queryEmbedding?: Float32Array;
    vectorLimit?: number;
    /** Model name to filter text vector search (undefined = no filter) */
    textModel?: string;
    /** Code-specialized embedder for the code vector lane */
    codeEmbedder?: EmbedderLike | null;
    /** Model name for the code vector lane */
    codeModel?: string;
    /** Absolute path to the codebase root — required for symbol body injection */
    codePath?: string;
    /** "code" injects bound symbol bodies alongside concept prose. "arch" (default) returns prose only. */
    mode?: "arch" | "code";
    /** Ask-pipeline trace logger — logs lane/fusion/hydration events when provided */
    tracer?: AskTracer;
  },
): Promise<HybridSearchRun> {
  const sourceType = opts?.sourceType ?? "chunk";
  const limit = Math.max(1, opts?.limit ?? 10);
  const vectorLimit = Math.max(1, opts?.vectorLimit ?? 20);

  // Embed query with text model (skip if pre-computed)
  const queryEmbedding = opts?.queryEmbedding ?? (await embedder.embed(query));

  const codeLanePromise =
    opts?.codeEmbedder && opts?.codeModel && opts?.mode !== "arch"
      ? opts.codeEmbedder
          .embed(query)
          .then((codeQueryEmbedding) => {
            const results = vectorSearch(
              db,
              codeQueryEmbedding,
              "source",
              vectorLimit,
              opts.codeModel,
            );
            opts?.tracer?.log("lane.code", {
              source_type: "source",
              candidates: results.length,
              top10: results
                .slice(0, 10)
                .map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
            });
            return results;
          })
          .catch(() => {
            opts?.tracer?.log("lane.code", {
              source_type: "source",
              skipped: true,
              reason: "embedder error",
            });
            return [] as { chunkId: string; distance: number }[];
          })
      : null;

  // Lane 1: text vector search (qwen — prose space)
  const vectorResultsText = vectorSearch(
    db,
    queryEmbedding,
    sourceType,
    vectorLimit,
    opts?.textModel,
  );
  opts?.tracer?.log("lane.text", {
    source_type: sourceType,
    candidates: vectorResultsText.length,
    top10: vectorResultsText
      .slice(0, 10)
      .map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
  });

  // Lane 2: code vector search (voyage — source chunks space)
  // Skipped for arch mode: architectural questions use only concept prose + their bound symbol bodies.
  // Code lane errors are silently swallowed — if the code embedder is unavailable, degrade gracefully
  // to text + BM25 lanes rather than failing the entire search.
  let vectorResultsCode: { chunkId: string; distance: number }[] = [];
  if (codeLanePromise) {
    vectorResultsCode = await codeLanePromise;
  } else {
    opts?.tracer?.log("lane.code", {
      source_type: "source",
      skipped: true,
      reason: opts?.mode === "arch" ? "arch mode" : "no code embedder",
    });
  }

  // Lane 3: BM25 source chunk search — exact function/symbol name matches.
  // Active when searching concept chunks (not journal mode).
  // Normalized: FTS5 rank is negative (more negative = better); convert to distance in (0,1).
  let bm25SourceResults: { chunkId: string; distance: number }[] = [];
  if (sourceType === "chunk") {
    const bm25Hits = bm25Search(db, query, "source", vectorLimit);
    bm25SourceResults = bm25Hits.map((h, index) => ({
      chunkId: h.chunkId,
      distance: index / (index + 30),
    }));
    opts?.tracer?.log("lane.bm25_source", {
      source_type: "source",
      candidates: bm25SourceResults.length,
      top10: bm25SourceResults
        .slice(0, 10)
        .map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
    });
  } else {
    opts?.tracer?.log("lane.bm25_source", {
      source_type: sourceType,
      skipped: true,
      reason: "journal mode",
    });
  }

  // Lane 4: BM25 concept chunk search — exact keyword matches in concept prose.
  // Catches term queries that vector similarity misses (e.g. exact symbol names, config keys).
  // Active only for concept chunk searches, not journal or source-only searches.
  let bm25ChunkResults: { chunkId: string; distance: number }[] = [];
  if (sourceType === "chunk") {
    const bm25ChunkHits = bm25Search(db, query, "chunk", vectorLimit);
    bm25ChunkResults = bm25ChunkHits.map((h, index) => ({
      chunkId: h.chunkId,
      distance: index / (index + 30),
    }));
    opts?.tracer?.log("lane.bm25_chunk", {
      source_type: "chunk",
      candidates: bm25ChunkResults.length,
      top10: bm25ChunkResults
        .slice(0, 10)
        .map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
    });
  } else {
    opts?.tracer?.log("lane.bm25_chunk", {
      source_type: sourceType,
      skipped: true,
      reason: "journal mode",
    });
  }

  // Lane 5: Doc vector search — text files, configs, READMEs in the lake.
  // Active only for concept chunk searches (not journal mode).
  let vectorResultsDoc: { chunkId: string; distance: number }[] = [];
  if (sourceType === "chunk") {
    vectorResultsDoc = vectorSearch(db, queryEmbedding, "doc", vectorLimit, opts?.textModel);
    opts?.tracer?.log("lane.doc_vector", {
      source_type: "doc",
      candidates: vectorResultsDoc.length,
      top10: vectorResultsDoc
        .slice(0, 10)
        .map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
    });
  } else {
    opts?.tracer?.log("lane.doc_vector", {
      source_type: sourceType,
      skipped: true,
      reason: "journal mode",
    });
  }

  // Lane 6: BM25 doc search — exact keyword matches in doc content.
  let bm25DocResults: { chunkId: string; distance: number }[] = [];
  if (sourceType === "chunk") {
    const bm25DocHits = bm25Search(db, query, "doc", vectorLimit);
    bm25DocResults = bm25DocHits.map((h, index) => ({
      chunkId: h.chunkId,
      distance: index / (index + 30),
    }));
    opts?.tracer?.log("lane.bm25_doc", {
      source_type: "doc",
      candidates: bm25DocResults.length,
      top10: bm25DocResults.slice(0, 10).map((r) => ({ chunkId: r.chunkId, distance: r.distance })),
    });
  } else {
    opts?.tracer?.log("lane.bm25_doc", {
      source_type: sourceType,
      skipped: true,
      reason: "journal mode",
    });
  }

  // Merge lanes by raw distance — tight distances win naturally.
  // Vector distances (cosine) are in [0,1]. BM25 distances use rank-position normalization
  // index/(index+30): rank-0 → 0.0, rank-9 → 0.23, rank-29 → 0.49, keeping BM25 competitive
  // with vector distances for strong keyword matches.
  const fused = mergeByDistance(
    vectorResultsText,
    vectorResultsCode,
    bm25SourceResults,
    bm25ChunkResults,
    vectorResultsDoc,
    bm25DocResults,
  );
  opts?.tracer?.log("fusion", {
    source_type: sourceType,
    candidates: fused.length,
    top10: fused.slice(0, 10).map((r) => ({ chunkId: r.chunkId, score: r.score })),
  });

  // Hydrate top results with content
  const hydrated = await mapConcurrent(fused.slice(0, limit), 6, async (item) => {
    const chunkRow = getChunk(db, item.chunkId);
    if (!chunkRow) return null;

    const parsed = await readChunk(chunkRow.file_path);
    const fm = parsed.frontmatter;

    let content = parsed.content;
    let concept: string | undefined;
    let warning: string | undefined;

    if (fm.fl_type === "source") {
      const sfm = fm as SourceChunkFrontmatter;
      content = `[Source: ${sfm.fl_source_file}:${sfm.fl_line_start}-${sfm.fl_line_end}]\n\`\`\`${sfm.fl_language}\n${parsed.content}\n\`\`\``;
      concept = sfm.fl_symbol as string;
    } else if (fm.fl_type === "doc") {
      const dfm = fm as DocChunkFrontmatter;
      const truncated = parsed.content.slice(0, 4000);
      content = `[Doc: ${dfm.fl_doc_path}]\n${truncated}`;
      concept = dfm.fl_doc_path;
    } else {
      if ("fl_residual" in fm && fm.fl_residual != null && fm.fl_residual > 0.5) {
        warning = "high residual — verify against code";
      }
      if ("fl_staleness" in fm && fm.fl_staleness != null && fm.fl_staleness > 0.5) {
        warning = "content may be stale";
      }
      concept = chunkRow.concept_id
        ? (getConcept(db, chunkRow.concept_id)?.name ??
          ("fl_concept" in fm ? (fm as { fl_concept: string }).fl_concept : undefined))
        : "fl_concept" in fm
          ? (fm as { fl_concept: string }).fl_concept
          : undefined;

      if (fm.fl_type === "chunk" && chunkRow.concept_id && opts?.codePath) {
        const boundSyms = db
          .query<
            {
              qualified_name: string;
              file_path: string;
              line_start: number;
              line_end: number;
              language: string;
            },
            [string]
          >(
            `SELECT s.qualified_name, sf.file_path, s.line_start, s.line_end, sf.language
             FROM concept_symbols cs
             JOIN symbols s ON cs.symbol_id = s.id
             JOIN source_files sf ON s.source_file_id = sf.id
             WHERE cs.concept_id = ?
             ORDER BY cs.confidence DESC
             LIMIT 5`,
          )
          .all(chunkRow.concept_id);

        const symbolBodies = await Promise.all(
          boundSyms.map(async (sym) => ({
            sym,
            body: await readSymbolContent(
              opts.codePath!,
              sym.file_path,
              sym.line_start,
              sym.line_end,
            ),
          })),
        );

        for (const { sym, body } of symbolBodies) {
          if (!body) continue;
          content += `\n\n[Symbol: ${sym.qualified_name} (${sym.file_path}:${sym.line_start}-${sym.line_end})]\n\`\`\`${sym.language}\n${body}\n\`\`\``;
        }
      }
    }

    const result: HybridSearchResult = {
      chunkId: item.chunkId,
      score: item.score,
      content,
    };
    if (concept !== undefined) result.concept = concept;
    if (warning !== undefined) result.warning = warning;
    return result;
  });
  const results = hydrated.flatMap((result) => (result ? [result] : []));

  opts?.tracer?.log("hydration", {
    source_type: sourceType,
    hydrated: results.length,
    items: results.map((r) => ({
      chunkId: r.chunkId,
      score: r.score,
      concept: r.concept,
      fl_type: r.content.startsWith("[Source:") ? "source" : "chunk",
    })),
  });

  return {
    results,
    stats: {
      text_vector_candidates: vectorResultsText.length,
      code_vector_candidates: vectorResultsCode.length,
      bm25_source_candidates: bm25SourceResults.length,
      bm25_chunk_candidates: bm25ChunkResults.length,
      doc_vector_candidates: vectorResultsDoc.length,
      bm25_doc_candidates: bm25DocResults.length,
      fused_candidates: fused.length,
    },
  };
}
