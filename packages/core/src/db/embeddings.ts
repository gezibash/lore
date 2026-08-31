import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { EmbeddingRow, VectorSearchResult } from "@/types/index.ts";

/**
 * A concept chunk is reachable when no later version supersedes it and its
 * concept is active. Every read path applies this test, so a count that reports
 * the lake must apply it too. The clauses need `chunks c` and
 * `LEFT JOIN current_concepts cc ON cc.id = c.concept_id` in scope.
 *
 * Only fl_type 'chunk' carries a lifecycle. A source or journal row is
 * reachable as soon as its chunk exists.
 */
const LIVE_CHUNK_CLAUSES = `c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
         AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active')`;

export function insertEmbedding(
  db: Database,
  chunkId: string,
  embedding: Float32Array,
  model: string,
): string {
  const id = ulid();
  const now = new Date().toISOString();
  // INSERT OR REPLACE: with the (chunk_id, model) unique index from migration 016,
  // this updates an existing embedding for the same chunk+model rather than duplicating.
  db.run(
    `INSERT OR REPLACE INTO embeddings (id, chunk_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, chunkId, new Uint8Array(embedding.buffer), model, now],
  );
  return id;
}

export function insertEmbeddingBatch(
  db: Database,
  items: Array<{ chunkId: string; embedding: Float32Array; model: string }>,
): void {
  if (items.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO embeddings (id, chunk_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const item of items) {
    stmt.run(ulid(), item.chunkId, new Uint8Array(item.embedding.buffer), item.model, now);
  }
}

export function getEmbeddingForChunk(db: Database, chunkId: string): EmbeddingRow | null {
  return (
    db.query<EmbeddingRow, [string]>("SELECT * FROM embeddings WHERE chunk_id = ?").get(chunkId) ??
    null
  );
}

export function vectorSearch(
  db: Database,
  queryEmbedding: Float32Array,
  sourceType: "chunk" | "journal" | "source" | "doc" = "chunk",
  limit: number = 20,
  model?: string,
): VectorSearchResult[] {
  const queryBlob = new Uint8Array(queryEmbedding.buffer);

  // journal and source: simple type filter, no lifecycle guard needed
  // Secondary sort by created_at DESC: when distances are equal, newer chunks win (recency tie-breaker).
  if (sourceType === "journal" || sourceType === "source" || sourceType === "doc") {
    if (model) {
      return db
        .query<VectorSearchResult, [Uint8Array, string, string, number]>(
          `SELECT e.chunk_id as chunkId,
                  vec_distance_cosine(e.embedding, ?) AS distance
           FROM embeddings e
           JOIN chunks c ON c.id = e.chunk_id
           WHERE c.fl_type = ? AND e.model = ?
           ORDER BY distance ASC, c.created_at DESC
           LIMIT ?`,
        )
        .all(queryBlob, sourceType, model, limit);
    }
    return db
      .query<VectorSearchResult, [Uint8Array, string, number]>(
        `SELECT e.chunk_id as chunkId,
                vec_distance_cosine(e.embedding, ?) AS distance
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         WHERE c.fl_type = ?
         ORDER BY distance ASC, c.created_at DESC
         LIMIT ?`,
      )
      .all(queryBlob, sourceType, limit);
  }

  // chunk: needs lifecycle guards (active concepts, not superseded)
  if (model) {
    return db
      .query<VectorSearchResult, [Uint8Array, string, number]>(
        `SELECT e.chunk_id as chunkId,
                vec_distance_cosine(e.embedding, ?) AS distance
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         LEFT JOIN current_concepts cc ON cc.id = c.concept_id
         WHERE c.fl_type = 'chunk'
           AND e.model = ?
           AND ${LIVE_CHUNK_CLAUSES}
         ORDER BY distance ASC
         LIMIT ?`,
      )
      .all(queryBlob, model, limit);
  }

  return db
    .query<VectorSearchResult, [Uint8Array, number]>(
      `SELECT e.chunk_id as chunkId,
              vec_distance_cosine(e.embedding, ?) AS distance
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       LEFT JOIN current_concepts cc ON cc.id = c.concept_id
       WHERE c.fl_type = 'chunk'
         AND ${LIVE_CHUNK_CLAUSES}
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(queryBlob, limit);
}

export function getAllEmbeddings(
  db: Database,
  sourceType: "chunk" | "journal" = "chunk",
): Array<{ chunk_id: string; embedding: Uint8Array }> {
  if (sourceType === "journal") {
    return db
      .query<{ chunk_id: string; embedding: Uint8Array }, []>(
        `SELECT e.chunk_id, e.embedding
         FROM embeddings e
         JOIN chunks c ON c.id = e.chunk_id
         WHERE c.fl_type = 'journal'`,
      )
      .all();
  }

  return db
    .query<{ chunk_id: string; embedding: Uint8Array }, [string]>(
      `SELECT e.chunk_id, e.embedding
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       LEFT JOIN current_concepts cc ON cc.id = c.concept_id
       WHERE c.fl_type = ?
         AND ${LIVE_CHUNK_CLAUSES}`,
    )
    .all(sourceType);
}

export function deleteAllEmbeddings(db: Database): void {
  db.run("DELETE FROM embeddings");
}

/**
 * Count the reachable embeddings of each model.
 *
 * The join drops orphans. A mind written before chunk replacement cleared its
 * dependents holds an embedding for every chunk that has since gone. Those rows
 * reach no result set, so a count that holds them overstates the lake. An
 * orphan on an outdated model then raises a refresh the mind does not need.
 *
 * A superseded chunk and an archived concept both keep their chunk row, so the
 * join alone lets their embeddings through. LIVE_CHUNK_CLAUSES drops those too,
 * which is what the read paths do.
 */
export function countEmbeddingsByModel(db: Database): Array<{ model: string; cnt: number }> {
  return db
    .query<{ model: string; cnt: number }, []>(
      `SELECT e.model, COUNT(*) AS cnt
       FROM embeddings e
       JOIN chunks c ON c.id = e.chunk_id
       LEFT JOIN current_concepts cc ON cc.id = c.concept_id
       WHERE c.fl_type <> 'chunk' OR (${LIVE_CHUNK_CLAUSES})
       GROUP BY e.model
       ORDER BY e.model`,
    )
    .all();
}

// ─── Symbol Embeddings (code lane) ───────────────────────

export function insertSymbolEmbedding(
  db: Database,
  symbolId: string,
  embedding: Float32Array,
  model: string,
): string {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT OR REPLACE INTO symbol_embeddings (id, symbol_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, symbolId, new Uint8Array(embedding.buffer), model, now],
  );
  return id;
}

export function insertSymbolEmbeddingBatch(
  db: Database,
  items: Array<{ symbolId: string; embedding: Float32Array; model: string }>,
): void {
  if (items.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO symbol_embeddings (id, symbol_id, embedding, model, embedded_at)
     VALUES (?, ?, ?, ?, ?)`,
  );
  const now = new Date().toISOString();
  for (const item of items) {
    stmt.run(ulid(), item.symbolId, new Uint8Array(item.embedding.buffer), item.model, now);
  }
}

export function symbolVectorSearch(
  db: Database,
  queryEmbedding: Float32Array,
  model: string,
  limit: number = 20,
): VectorSearchResult[] {
  const queryBlob = new Uint8Array(queryEmbedding.buffer);
  return db
    .query<VectorSearchResult, [Uint8Array, string, number]>(
      `SELECT cc.active_chunk_id AS chunkId,
              MIN(vec_distance_cosine(se.embedding, ?)) AS distance
       FROM symbol_embeddings se
       JOIN concept_symbols cs ON cs.symbol_id = se.symbol_id
       JOIN current_concepts cc ON cc.id = cs.concept_id
       WHERE se.model = ?
         AND cc.lifecycle_status = 'active'
         AND cc.active_chunk_id IS NOT NULL
       GROUP BY cc.active_chunk_id
       ORDER BY distance ASC
       LIMIT ?`,
    )
    .all(queryBlob, model, limit);
}

export interface SymbolEmbeddingLane {
  /** Live symbols in the mind. */
  symbols: number;
  /** Live symbols that hold at least one embedding. */
  embedded: number;
  /** Of those, the ones the current code model can read. */
  currentModel: number;
}

/**
 * Measure the code lane's second table, in symbols.
 *
 * The code lane writes two tables. countEmbeddingsByModel reads the source
 * chunks in `embeddings`; the symbols live here, under the same code model.
 * symbolVectorSearch and the cache that binding extraction loads both filter on
 * the model, so a symbol the current model cannot read returns nothing rather
 * than a wrong answer.
 *
 * The unit is symbols, not rows. The unique index is (symbol_id, model), so a
 * symbol keeps its old row when a new model writes a second one. Those symbols
 * read correctly, and a row count would report them as broken. `embedded` minus
 * `currentModel` is therefore the figure that matters: the symbols no reader
 * can reach.
 *
 * The query drives off `symbols`, so it drops orphans the way the prune does
 * (see SYMBOL_KEYED_TABLES in db/symbols.ts). Both subqueries seek
 * idx_symbol_embeddings_symbol_model, whose leading column they carry, so the
 * whole lane costs one scan of `symbols` and no sort. A GROUP BY over the model
 * would have added a temp b-tree, and COUNT(DISTINCT) one per aggregate.
 */
export function countSymbolEmbeddingLane(
  db: Database,
  currentCodeModel: string | null,
): SymbolEmbeddingLane {
  const row = db
    .query<{ symbols: number; embedded: number; current_model: number }, [string | null]>(
      `SELECT COUNT(*) AS symbols,
              SUM(EXISTS (SELECT 1 FROM symbol_embeddings se WHERE se.symbol_id = s.id))
                AS embedded,
              SUM(EXISTS (SELECT 1 FROM symbol_embeddings se
                          WHERE se.symbol_id = s.id AND se.model = ?)) AS current_model
       FROM symbols s`,
    )
    .get(currentCodeModel);
  return {
    symbols: row?.symbols ?? 0,
    embedded: row?.embedded ?? 0,
    currentModel: row?.current_model ?? 0,
  };
}

/** The models on the rows the current code model cannot read. Called only when the lane is stale. */
export function staleSymbolEmbeddingModels(
  db: Database,
  currentCodeModel: string | null,
): string[] {
  return db
    .query<{ model: string }, [string | null, string | null]>(
      `SELECT DISTINCT se.model
       FROM symbol_embeddings se
       JOIN symbols s ON s.id = se.symbol_id
       WHERE ? IS NULL OR se.model <> ?
       ORDER BY se.model`,
    )
    .all(currentCodeModel, currentCodeModel)
    .map((r) => r.model);
}

export function deleteAllSymbolEmbeddings(db: Database): void {
  db.run("DELETE FROM symbol_embeddings");
}
