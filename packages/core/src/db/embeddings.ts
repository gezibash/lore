import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { EmbeddingRow, VectorSearchResult } from "@/types/index.ts";

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
           AND c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
           AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active')
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
         AND c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
         AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active')
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
         AND c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
         AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active')`,
    )
    .all(sourceType);
}

export function deleteAllEmbeddings(db: Database): void {
  db.run("DELETE FROM embeddings");
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

export function deleteAllSymbolEmbeddings(db: Database): void {
  db.run("DELETE FROM symbol_embeddings");
}
