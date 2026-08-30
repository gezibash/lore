import type { Database } from "bun:sqlite";
import type { SymbolRow, SymbolKind, SymbolSearchResult } from "@/types/index.ts";
import { ulid } from "ulid";

/** Symbol kinds that can enclose other definitions. */
const CONTAINER_KINDS = new Set<SymbolKind>(["class", "struct", "trait", "impl", "interface"]);

export interface InsertSymbolOpts {
  sourceFileId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  parentId: string | null;
  /** Enclosing class/impl/module name. Resolved to `parentId` within the batch. */
  parentName?: string | null;
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

  // Assign ids up front so a child can point at a parent declared later in the file.
  const ids = symbols.map(() => ulid());
  const containerIds = new Map<string, string>();
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]!;
    // Containers are keyed by their own qualified name, so a nested class resolves too.
    if (CONTAINER_KINDS.has(s.kind)) containerIds.set(s.qualifiedName, ids[i]!);
  }

  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i]!;
    const id = ids[i]!;
    // qualifiedName is `<parentName>.<name>`, so the container key is the qualified name
    // minus the trailing segment — this resolves nested containers, not just top-level ones.
    const parentId =
      s.parentId ??
      (s.parentName != null
        ? (containerIds.get(s.qualifiedName.slice(0, -(s.name.length + 1))) ??
          containerIds.get(s.parentName) ??
          null)
        : null);
    insertSym.run(
      id,
      sourceFileId,
      s.name,
      s.qualifiedName,
      s.kind,
      parentId,
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
  const doomed = `SELECT id FROM symbols WHERE source_file_id = ?`;
  const params: [string] = [sourceFileId];
  // FTS entries must be deleted first (before cascade removes symbols)
  db.run(`DELETE FROM symbol_fts WHERE symbol_id IN (${doomed})`, params);
  // concept_symbols has no FK to symbols, so its rows must be dropped explicitly or they
  // survive as orphans pointing at deleted symbol ids — inflating binding counts on every
  // rescan. Callers that intend to keep bindings snapshot them first (saveBindingsForSourceFile)
  // and re-attach after re-insert (rematchBindings).
  db.run(`DELETE FROM concept_symbols WHERE symbol_id IN (${doomed})`, params);
  // symbol_embeddings has no FK either. insertSymbolBatch mints a fresh id for
  // every symbol on every scan, so a changed file leaves one dead vector per
  // symbol of the previous version. The unique index on (symbol_id, model)
  // cannot reclaim them: INSERT OR REPLACE only matches an id that never
  // comes back.
  db.run(`DELETE FROM symbol_embeddings WHERE symbol_id IN (${doomed})`, params);
  db.run(`DELETE FROM symbols WHERE source_file_id = ?`, params);
}

/** Rows in a symbol-keyed table whose symbol is gone, one count per table. */
export interface OrphanedSymbolRows {
  symbol_embeddings: number;
  symbol_fts: number;
}

// Symbol-keyed tables that no other sweep owns. concept_symbols is left out on
// purpose: pruneOrphanedBindings already clears it, and it drops bindings whose
// concept is gone as well. NOT EXISTS, not NOT IN: SQLite lets a TEXT PRIMARY
// KEY hold NULL, and one NULL id makes NOT IN match nothing.
const SYMBOL_KEYED_TABLES = ["symbol_embeddings", "symbol_fts"] as const;

function orphanPredicate(table: string): string {
  return `NOT EXISTS (SELECT 1 FROM symbols s WHERE s.id = ${table}.symbol_id)`;
}

/** Count the rows each symbol-keyed table holds for symbols that no longer exist. */
export function countOrphanedSymbolRows(db: Database): OrphanedSymbolRows {
  const counts = {} as OrphanedSymbolRows;
  for (const table of SYMBOL_KEYED_TABLES) {
    counts[table] =
      db
        .query<{ n: number }, []>(
          `SELECT COUNT(*) AS n FROM ${table} WHERE ${orphanPredicate(table)}`,
        )
        .get()?.n ?? 0;
  }
  return counts;
}

/**
 * Delete every row whose symbol is gone. Minds written before symbol
 * replacement cleared its own dependents carry one generation of these rows per
 * edit. Returns what it deleted, per table.
 */
export function deleteOrphanedSymbolRows(db: Database): OrphanedSymbolRows {
  const deleted = countOrphanedSymbolRows(db);
  for (const table of SYMBOL_KEYED_TABLES) {
    if (deleted[table] === 0) continue;
    db.run(`DELETE FROM ${table} WHERE ${orphanPredicate(table)}`);
  }
  return deleted;
}

/** Total orphaned rows across every symbol-keyed table. */
export function sumOrphanedSymbolRows(counts: OrphanedSymbolRows): number {
  return SYMBOL_KEYED_TABLES.reduce((total, table) => total + counts[table], 0);
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
