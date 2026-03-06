import type { Database } from "bun:sqlite";
import type { BM25SearchResult } from "@/types/index.ts";
import { expandCamelCase } from "./symbols.ts";

export function insertFtsContent(db: Database, content: string, chunkId: string): void {
  db.run("INSERT INTO content_fts (content, chunk_id) VALUES (?, ?)", [content, chunkId]);
}

export function insertFtsContentBatch(
  db: Database,
  items: Array<{ content: string; chunkId: string }>,
): void {
  if (items.length === 0) return;
  const stmt = db.prepare("INSERT INTO content_fts (content, chunk_id) VALUES (?, ?)");
  for (const item of items) {
    stmt.run(item.content, item.chunkId);
  }
}

/**
 * Sanitize a query string for FTS5 MATCH syntax.
 * Strips operators and wraps individual terms in quotes.
 */
function sanitizeFtsQuery(query: string): string {
  const expanded = expandCamelCase(query);
  const terms = expanded
    .replace(/[^\w\s-]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 0);
  if (terms.length === 0) return '""';
  return terms.map((t) => `"${t}"`).join(" OR ");
}

export function bm25Search(
  db: Database,
  query: string,
  sourceType?: "chunk" | "journal" | "source" | "doc",
  limit: number = 20,
): BM25SearchResult[] {
  const sanitized = sanitizeFtsQuery(query);
  try {
    if (sourceType) {
      if (sourceType === "chunk") {
        return db
          .query<BM25SearchResult, [string, number]>(
            `SELECT f.chunk_id as chunkId, f.rank
             FROM content_fts f
             JOIN chunks c ON c.id = f.chunk_id
             LEFT JOIN current_concepts cc ON cc.id = c.concept_id
             WHERE content_fts MATCH ?
               AND c.fl_type = 'chunk'
               AND c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
               AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active')
             ORDER BY f.rank, c.created_at DESC
             LIMIT ?`,
          )
          .all(sanitized, limit);
      }

      if (sourceType === "source") {
        return db
          .query<BM25SearchResult, [string, number]>(
            `SELECT f.chunk_id as chunkId, f.rank
             FROM content_fts f
             JOIN chunks c ON c.id = f.chunk_id
             WHERE content_fts MATCH ?
               AND c.fl_type = 'source'
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(sanitized, limit);
      }

      if (sourceType === "doc") {
        return db
          .query<BM25SearchResult, [string, number]>(
            `SELECT f.chunk_id as chunkId, f.rank
             FROM content_fts f
             JOIN chunks c ON c.id = f.chunk_id
             WHERE content_fts MATCH ?
               AND c.fl_type = 'doc'
             ORDER BY f.rank
             LIMIT ?`,
          )
          .all(sanitized, limit);
      }

      // Secondary sort by created_at DESC: when BM25 rank is equal, newer chunks win.
      return db
        .query<BM25SearchResult, [string, string, number]>(
          `SELECT f.chunk_id as chunkId, f.rank
           FROM content_fts f
           JOIN chunks c ON c.id = f.chunk_id
           WHERE content_fts MATCH ? AND c.fl_type = ?
           ORDER BY f.rank, c.created_at DESC
           LIMIT ?`,
        )
        .all(sanitized, sourceType, limit);
    }
    return db
      .query<BM25SearchResult, [string, number]>(
        `SELECT chunk_id as chunkId, rank
         FROM content_fts
         WHERE content_fts MATCH ?
         ORDER BY rank
         LIMIT ?`,
      )
      .all(sanitized, limit);
  } catch {
    return [];
  }
}

export function deleteAllFts(db: Database): void {
  db.run("DELETE FROM content_fts");
}
