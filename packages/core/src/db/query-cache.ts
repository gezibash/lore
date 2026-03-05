import type { Database } from "bun:sqlite";

export interface QueryCacheRow {
  id: string;
  query_text: string;
  query_embedding: Uint8Array | null;
  result_json: string;
  score: number | null;
  scored_by: string | null;
  scored_at: string | null;
  created_at: string;
  expires_at: string | null;
}

export function insertQueryCache(
  db: Database,
  opts: {
    id: string;
    queryText: string;
    queryEmbedding?: Float32Array | null;
    resultJson: string;
    createdAt: string;
    expiresAt?: string | null;
  },
): void {
  const embeddingBlob = opts.queryEmbedding
    ? new Uint8Array(opts.queryEmbedding.buffer)
    : null;
  db.run(
    `INSERT INTO query_cache (id, query_text, query_embedding, result_json, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.queryText,
      embeddingBlob,
      opts.resultJson,
      opts.createdAt,
      opts.expiresAt ?? null,
    ],
  );
}

export function getQueryCache(db: Database, id: string): QueryCacheRow | null {
  return (
    db
      .query<QueryCacheRow, [string]>(
        `SELECT id, query_text, query_embedding, result_json, score, scored_by, scored_at, created_at, expires_at
         FROM query_cache WHERE id = ?`,
      )
      .get(id) ?? null
  );
}

export function scoreQueryCache(
  db: Database,
  id: string,
  score: number,
  scoredBy?: string,
): boolean {
  const now = new Date().toISOString();
  const result = db.run(
    `UPDATE query_cache SET score = ?, scored_by = ?, scored_at = ? WHERE id = ?`,
    [score, scoredBy ?? "agent", now, id],
  );
  return result.changes > 0;
}

export function getTopScoredQueries(
  db: Database,
  limit: number = 20,
): QueryCacheRow[] {
  return db
    .query<QueryCacheRow, [number]>(
      `SELECT id, query_text, query_embedding, result_json, score, scored_by, scored_at, created_at, expires_at
       FROM query_cache WHERE score IS NOT NULL ORDER BY score DESC LIMIT ?`,
    )
    .all(limit);
}

export function pruneExpiredQueryCache(db: Database): number {
  const now = new Date().toISOString();
  const result = db.run(
    `DELETE FROM query_cache WHERE expires_at IS NOT NULL AND expires_at < ?`,
    [now],
  );
  return result.changes;
}
