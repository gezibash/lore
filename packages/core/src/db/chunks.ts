import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ChunkRow, ChunkType, JournalStatus, ChunkConceptMapRow, FileRef } from "@/types/index.ts";

export interface InsertChunkOpts {
  id: string;
  filePath: string;
  flType: ChunkType;
  conceptId?: string | null;
  narrativeId?: string | null;
  supersedesId?: string | null;
  status?: JournalStatus | null;
  topics?: string[] | null;
  convergence?: number | null;
  theta?: number | null;
  magnitude?: number | null;
  createdAt: string;
  sourceFilePath?: string | null;
  conceptRefs?: string[] | null;
  symbolRefs?: string[] | null;
  fileRefs?: FileRef[] | null;
}

export function insertChunk(db: Database, opts: InsertChunkOpts): void {
  db.run(
    `INSERT INTO chunks (id, file_path, fl_type, concept_id, narrative_id,
       supersedes_id, status, topics, convergence, theta, magnitude, created_at, source_file_path,
       concept_refs, symbol_refs, file_refs)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.filePath,
      opts.flType,
      opts.conceptId ?? null,
      opts.narrativeId ?? null,
      opts.supersedesId ?? null,
      opts.status ?? null,
      opts.topics ? JSON.stringify(opts.topics) : null,
      opts.convergence ?? null,
      opts.theta ?? null,
      opts.magnitude ?? null,
      opts.createdAt,
      opts.sourceFilePath ?? null,
      opts.conceptRefs ? JSON.stringify(opts.conceptRefs) : null,
      opts.symbolRefs ? JSON.stringify(opts.symbolRefs) : null,
      opts.fileRefs ? JSON.stringify(opts.fileRefs) : null,
    ],
  );
}

export function getChunk(db: Database, id: string): ChunkRow | null {
  return db.query<ChunkRow, [string]>("SELECT * FROM chunks WHERE id = ?").get(id) ?? null;
}

export function getActiveChunks(db: Database): ChunkRow[] {
  return db
    .query<ChunkRow, []>(
      `SELECT * FROM chunks
       WHERE fl_type = 'chunk'
         AND id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
       ORDER BY created_at`,
    )
    .all();
}

export function getChunksForConcept(db: Database, conceptId: string): ChunkRow[] {
  return db
    .query<ChunkRow, [string]>("SELECT * FROM chunks WHERE concept_id = ? ORDER BY created_at")
    .all(conceptId);
}

export function getJournalChunksForNarrative(db: Database, narrativeId: string): ChunkRow[] {
  return db
    .query<ChunkRow, [string]>(
      `SELECT * FROM chunks WHERE narrative_id = ? AND fl_type = 'journal' ORDER BY created_at`,
    )
    .all(narrativeId);
}

export function getJournalTopicsForNarrative(db: Database, narrativeId: string): string[] {
  const rows = db
    .query<{ topics: string | null }, [string]>(
      `SELECT DISTINCT topics FROM chunks WHERE narrative_id = ? AND fl_type = 'journal' AND topics IS NOT NULL`,
    )
    .all(narrativeId);
  const all = new Set<string>();
  for (const r of rows) {
    if (r.topics) for (const t of JSON.parse(r.topics) as string[]) all.add(t);
  }
  return [...all];
}

export function getChunkCount(db: Database): number {
  const row = db
    .query<{ count: number }, []>(
      `SELECT COUNT(*) as count FROM chunks
       WHERE fl_type = 'chunk'
         AND id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)`,
    )
    .get();
  return row?.count ?? 0;
}

/** Assign a chunk to a concept via the append-only chunk_concept_map. */
export function assignChunkToConcept(db: Database, chunkId: string, conceptId: string): void {
  db.run(
    `INSERT INTO chunk_concept_map (version_id, chunk_id, concept_id, inserted_at)
     VALUES (?, ?, ?, ?)`,
    [ulid(), chunkId, conceptId, new Date().toISOString()],
  );
}

/** Get the last closed narrative that produced content for a concept. */
export function getLastNarrativeForConcept(
  db: Database,
  conceptId: string,
): { name: string; intent: string; closed_at: string } | null {
  const row = db
    .query<{ name: string; intent: string; closed_at: string }, [string]>(
      `SELECT d.name, d.intent, d.closed_at
       FROM chunks c
       JOIN current_narratives d ON d.id = c.narrative_id
       WHERE c.concept_id = ?
         AND c.fl_type = 'chunk'
         AND d.status = 'closed'
         AND d.closed_at IS NOT NULL
       ORDER BY c.created_at DESC
       LIMIT 1`,
    )
    .get(conceptId);
  return row ?? null;
}

/** Get all source chunk file paths for a given source file (for disk cleanup). */
export function getSourceChunkPathsForFile(db: Database, sourceFilePath: string): string[] {
  const rows = db
    .query<{ file_path: string }, [string]>(
      `SELECT file_path FROM chunks WHERE fl_type = 'source' AND source_file_path = ?`,
    )
    .all(sourceFilePath);
  return rows.map((r) => r.file_path);
}

/** Delete all source chunks for a given source file from the DB. */
export function deleteSourceChunksForFile(db: Database, sourceFilePath: string): void {
  db.run(`DELETE FROM chunks WHERE fl_type = 'source' AND source_file_path = ?`, [sourceFilePath]);
}

/** Get doc chunk (by source_file_path = relative docPath). Returns the first chunk found or null. */
export function getDocChunkByPath(db: Database, docPath: string): ChunkRow | null {
  return (
    db
      .query<ChunkRow, [string]>(
        `SELECT * FROM chunks WHERE fl_type = 'doc' AND source_file_path = ? LIMIT 1`,
      )
      .get(docPath) ?? null
  );
}

/** Get all doc chunk paths currently in the DB (source_file_path = relative docPath). */
export function getDocChunkPaths(db: Database): string[] {
  const rows = db
    .query<{ source_file_path: string }, []>(
      `SELECT DISTINCT source_file_path FROM chunks WHERE fl_type = 'doc' AND source_file_path IS NOT NULL`,
    )
    .all();
  return rows.map((r) => r.source_file_path);
}

/** Delete all doc chunks for a given doc path from the DB (and FTS). */
export function deleteDocChunksForFile(db: Database, docPath: string): void {
  // Remove from FTS first (referential — chunk_id links)
  db.run(
    `DELETE FROM content_fts WHERE chunk_id IN (
       SELECT id FROM chunks WHERE fl_type = 'doc' AND source_file_path = ?
     )`,
    [docPath],
  );
  db.run(`DELETE FROM chunks WHERE fl_type = 'doc' AND source_file_path = ?`, [docPath]);
}

/** Count all source chunks (one per indexed symbol). */
export function getSourceChunkCount(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(`SELECT COUNT(*) as count FROM chunks WHERE fl_type = 'source'`)
      .get()?.count ?? 0
  );
}

/** Count all doc chunks (one per ingested doc/config file). */
export function getDocChunkCount(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(`SELECT COUNT(*) as count FROM chunks WHERE fl_type = 'doc'`)
      .get()?.count ?? 0
  );
}

/** Get the timestamp of the most recently ingested doc chunk. */
export function getLastDocIndexedAt(db: Database): string | null {
  return (
    db
      .query<{ created_at: string }, []>(
        `SELECT created_at FROM chunks WHERE fl_type = 'doc' ORDER BY created_at DESC LIMIT 1`,
      )
      .get()?.created_at ?? null
  );
}

/** Count all journal chunks (cumulative entries across all deltas). */
export function getJournalEntryCount(db: Database): number {
  return (
    db
      .query<{ count: number }, []>(
        `SELECT COUNT(*) as count FROM chunks WHERE fl_type = 'journal'`,
      )
      .get()?.count ?? 0
  );
}

/** Get the latest concept assignment for a chunk. */
export function getChunkConceptId(db: Database, chunkId: string): string | null {
  const row = db
    .query<ChunkConceptMapRow, [string]>("SELECT * FROM current_chunk_concepts WHERE chunk_id = ?")
    .get(chunkId);
  return row?.concept_id ?? null;
}
