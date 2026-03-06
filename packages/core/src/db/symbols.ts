import type { Database } from "bun:sqlite";
import type { SymbolRow, SymbolKind, SymbolSearchResult } from "@/types/index.ts";
import { ulid } from "ulid";

export interface InsertSymbolOpts {
  sourceFileId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  parentId: string | null;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  bodyHash: string | null;
  exportStatus: "exported" | "default_export" | "local" | null;
}

export function insertSymbol(db: Database, opts: InsertSymbolOpts): SymbolRow {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, parent_id, line_start, line_end, signature, body_hash, export_status, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      opts.sourceFileId,
      opts.name,
      opts.qualifiedName,
      opts.kind,
      opts.parentId,
      opts.lineStart,
      opts.lineEnd,
      opts.signature,
      opts.bodyHash,
      opts.exportStatus,
      now,
    ],
  );
  return {
    id,
    source_file_id: opts.sourceFileId,
    name: opts.name,
    qualified_name: opts.qualifiedName,
    kind: opts.kind,
    parent_id: opts.parentId,
    line_start: opts.lineStart,
    line_end: opts.lineEnd,
    signature: opts.signature,
    body_hash: opts.bodyHash,
    export_status: opts.exportStatus,
    scanned_at: now,
  };
}

export function insertSymbolBatch(
  db: Database,
  sourceFileId: string,
  filePath: string,
  symbols: InsertSymbolOpts[],
): void {
  const now = new Date().toISOString();
  const insertSym = db.prepare(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, parent_id, line_start, line_end, signature, body_hash, export_status, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertFts = db.prepare(
    `INSERT INTO symbol_fts (name, qualified_name, signature, symbol_id, source_file_path)
     VALUES (?, ?, ?, ?, ?)`,
  );

  for (const s of symbols) {
    const id = ulid();
    insertSym.run(
      id,
      sourceFileId,
      s.name,
      s.qualifiedName,
      s.kind,
      s.parentId,
      s.lineStart,
      s.lineEnd,
      s.signature,
      s.bodyHash,
      s.exportStatus,
      now,
    );
    insertFts.run(s.name, s.qualifiedName, s.signature ?? "", id, filePath);
  }
}

export function deleteSymbolsForSourceFile(db: Database, sourceFileId: string): void {
  // FTS entries must be deleted first (before cascade removes symbols)
  db.run(
    `DELETE FROM symbol_fts WHERE symbol_id IN (SELECT id FROM symbols WHERE source_file_id = ?)`,
    [sourceFileId],
  );
  db.run(`DELETE FROM symbols WHERE source_file_id = ?`, [sourceFileId]);
}

export function getSymbolsForSourceFile(db: Database, sourceFileId: string): SymbolRow[] {
  return db
    .query<SymbolRow, [string]>(
      `SELECT * FROM symbols WHERE source_file_id = ? ORDER BY line_start`,
    )
    .all(sourceFileId);
}

export function getSymbolsForFilePath(db: Database, filePath: string): SymbolRow[] {
  return db
    .query<SymbolRow, [string]>(
      `SELECT s.* FROM symbols s
       JOIN source_files sf ON s.source_file_id = sf.id
       WHERE sf.file_path = ?
       ORDER BY s.line_start`,
    )
    .all(filePath);
}

/**
 * Splits camelCase/PascalCase tokens into their component words and adds them
 * as additional OR terms. Keeps the original token so exact matches still work.
 * Example: "computeStaleness" → "computeStaleness compute staleness"
 */
export function expandCamelCase(query: string): string {
  const terms = query.split(/\s+/).filter(Boolean);
  const expanded = new Set<string>();
  for (const term of terms) {
    expanded.add(term);
    const parts = term
      .replace(/([A-Z])/g, " $1")
      .trim()
      .toLowerCase()
      .split(/\s+/);
    if (parts.length > 1) parts.forEach((p) => expanded.add(p));
  }
  return Array.from(expanded).join(" ");
}

export function searchSymbols(
  db: Database,
  query: string,
  opts?: { limit?: number; kind?: SymbolKind },
): SymbolSearchResult[] {
  const limit = opts?.limit ?? 20;

  // FTS5 search on symbol names/signatures (with camelCase expansion)
  const expandedQuery = expandCamelCase(query);
  const ftsQuery = expandedQuery
    .split(/\s+/)
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, '""')}"`)
    .join(" OR ");

  if (!ftsQuery) return [];

  let sql = `
    SELECT
      s.id AS symbol_id,
      fts.source_file_path as file_path,
      s.name,
      s.qualified_name,
      s.kind,
      s.signature,
      s.line_start,
      s.line_end
    FROM symbol_fts fts
    JOIN symbols s ON fts.symbol_id = s.id
    WHERE symbol_fts MATCH ?
  `;
  const params: (string | number)[] = [ftsQuery];

  if (opts?.kind) {
    sql += ` AND s.kind = ?`;
    params.push(opts.kind);
  }

  sql += ` ORDER BY rank LIMIT ?`;
  params.push(limit);

  return db.query<SymbolSearchResult, (string | number)[]>(sql).all(...params);
}

export function getSymbolByQualifiedName(
  db: Database,
  qualifiedName: string,
): (SymbolRow & { file_path: string }) | null {
  return (
    db
      .query<SymbolRow & { file_path: string }, [string]>(
        `SELECT s.*, sf.file_path FROM symbols s
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE s.qualified_name = ?`,
      )
      .get(qualifiedName) ?? null
  );
}

export function getSymbolCount(db: Database): number {
  return db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM symbols`).get()?.count ?? 0;
}

export function getSymbolKindCounts(db: Database): Record<string, number> {
  const rows = db
    .query<{ kind: string; count: number }, []>(
      `SELECT kind, COUNT(*) as count FROM symbols GROUP BY kind`,
    )
    .all();
  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.kind] = row.count;
  }
  return result;
}
