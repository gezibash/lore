import type { Database } from "bun:sqlite";
import type { SourceFileRow, SupportedLanguage } from "@/types/index.ts";
import { ulid } from "ulid";

export interface InsertSourceFileOpts {
  filePath: string;
  language: SupportedLanguage;
  contentHash: string;
  sizeBytes: number;
  symbolCount: number;
}

export function insertSourceFile(db: Database, opts: InsertSourceFileOpts): SourceFileRow {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO source_files (id, file_path, language, content_hash, size_bytes, symbol_count, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.filePath, opts.language, opts.contentHash, opts.sizeBytes, opts.symbolCount, now],
  );
  return {
    id,
    file_path: opts.filePath,
    language: opts.language,
    content_hash: opts.contentHash,
    size_bytes: opts.sizeBytes,
    symbol_count: opts.symbolCount,
    scanned_at: now,
  };
}

export function upsertSourceFile(db: Database, opts: InsertSourceFileOpts): SourceFileRow {
  const existing = getSourceFileByPath(db, opts.filePath);
  if (existing) {
    const now = new Date().toISOString();
    db.run(
      `UPDATE source_files SET language = ?, content_hash = ?, size_bytes = ?, symbol_count = ?, scanned_at = ?
       WHERE id = ?`,
      [opts.language, opts.contentHash, opts.sizeBytes, opts.symbolCount, now, existing.id],
    );
    return {
      ...existing,
      language: opts.language,
      content_hash: opts.contentHash,
      size_bytes: opts.sizeBytes,
      symbol_count: opts.symbolCount,
      scanned_at: now,
    };
  }
  return insertSourceFile(db, opts);
}

export function getSourceFileByPath(db: Database, filePath: string): SourceFileRow | null {
  return (
    db
      .query<SourceFileRow, [string]>(`SELECT * FROM source_files WHERE file_path = ?`)
      .get(filePath) ?? null
  );
}

export function getSourceFile(db: Database, id: string): SourceFileRow | null {
  return (
    db.query<SourceFileRow, [string]>(`SELECT * FROM source_files WHERE id = ?`).get(id) ?? null
  );
}

export function getAllSourceFiles(db: Database): SourceFileRow[] {
  return db.query<SourceFileRow, []>(`SELECT * FROM source_files ORDER BY file_path`).all();
}

export function deleteSourceFile(db: Database, id: string): void {
  db.run(`DELETE FROM source_files WHERE id = ?`, [id]);
}

export function deleteSourceFileByPath(db: Database, filePath: string): void {
  db.run(`DELETE FROM source_files WHERE file_path = ?`, [filePath]);
}

export function deleteSourceFilesNotIn(db: Database, filePaths: Set<string>): number {
  const all = getAllSourceFiles(db);
  let removed = 0;
  for (const f of all) {
    if (!filePaths.has(f.file_path)) {
      deleteSourceFile(db, f.id);
      removed++;
    }
  }
  return removed;
}

export function getSourceFileCount(db: Database): number {
  return (
    db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM source_files`).get()?.count ?? 0
  );
}

export function getSourceFileLanguageCounts(db: Database): Record<string, number> {
  const rows = db
    .query<{ language: string; count: number }, []>(
      `SELECT language, COUNT(*) as count FROM source_files GROUP BY language`,
    )
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.language] = row.count;
  }
  return result;
}

export function getLastScannedAt(db: Database): string | null {
  return (
    db
      .query<{ scanned_at: string }, []>(
        `SELECT scanned_at FROM source_files ORDER BY scanned_at DESC LIMIT 1`,
      )
      .get()?.scanned_at ?? null
  );
}
