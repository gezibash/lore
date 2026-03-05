import type { Database } from "bun:sqlite";
import type {
  ConceptSymbolRow,
  ConceptBindingSummary,
  SymbolConceptMatch,
  SymbolDriftResult,
  BindingType,
  UncoveredSymbol,
  FileCoverageRow,
  CoverageStats,
  SupportedLanguage,
  SymbolKind,
} from "@/types/index.ts";
import { ulid } from "ulid";

export interface UpsertConceptSymbolOpts {
  conceptId: string;
  symbolId: string;
  bindingType: BindingType;
  boundBodyHash: string | null;
  /** Full body text of the symbol at binding time, for future drift diffs. */
  boundBody?: string | null;
  confidence: number;
}

export function upsertConceptSymbol(db: Database, opts: UpsertConceptSymbolOpts): ConceptSymbolRow {
  const now = new Date().toISOString();
  const id = ulid();
  db.run(
    `INSERT INTO concept_symbols (id, concept_id, symbol_id, binding_type, bound_body_hash, bound_body, confidence, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(concept_id, symbol_id) DO UPDATE SET
       binding_type = excluded.binding_type,
       bound_body_hash = excluded.bound_body_hash,
       bound_body = excluded.bound_body,
       confidence = excluded.confidence,
       updated_at = excluded.updated_at`,
    [
      id,
      opts.conceptId,
      opts.symbolId,
      opts.bindingType,
      opts.boundBodyHash,
      opts.boundBody ?? null,
      opts.confidence,
      now,
      now,
    ],
  );
  return {
    id,
    concept_id: opts.conceptId,
    symbol_id: opts.symbolId,
    binding_type: opts.bindingType,
    bound_body_hash: opts.boundBodyHash,
    bound_body: opts.boundBody ?? null,
    confidence: opts.confidence,
    created_at: now,
    updated_at: now,
  };
}

export function getBindingsForConcept(db: Database, conceptId: string): ConceptSymbolRow[] {
  return db
    .query<ConceptSymbolRow, [string]>(
      `SELECT * FROM concept_symbols WHERE concept_id = ? ORDER BY confidence DESC`,
    )
    .all(conceptId);
}

export function getBindingsForSymbol(db: Database, symbolId: string): ConceptSymbolRow[] {
  return db
    .query<ConceptSymbolRow, [string]>(
      `SELECT * FROM concept_symbols WHERE symbol_id = ? ORDER BY confidence DESC`,
    )
    .all(symbolId);
}

export function getConceptsForSymbols(db: Database, symbolIds: string[]): SymbolConceptMatch[] {
  if (symbolIds.length === 0) return [];
  const placeholders = symbolIds.map(() => "?").join(", ");
  return db
    .query<SymbolConceptMatch, string[]>(
      `SELECT cs.concept_id, c.name AS concept_name, cs.symbol_id, cs.binding_type, cs.confidence
       FROM concept_symbols cs
       JOIN current_concepts c ON cs.concept_id = c.id
       WHERE cs.symbol_id IN (${placeholders})`,
    )
    .all(...symbolIds);
}

export function getDriftedBindings(db: Database): SymbolDriftResult[] {
  return db
    .query<SymbolDriftResult, []>(
      `SELECT cs.concept_id, cs.symbol_id, cs.bound_body_hash, cs.bound_body, cs.binding_type, cs.confidence,
              s.body_hash AS current_body_hash, s.name AS symbol_name,
              s.qualified_name AS symbol_qualified_name, s.kind AS symbol_kind,
              s.signature, s.line_start, s.line_end, sf.file_path,
              (SELECT c.name FROM current_concepts c WHERE c.id = cs.concept_id) AS concept_name
       FROM concept_symbols cs
       JOIN symbols s ON cs.symbol_id = s.id
       JOIN source_files sf ON s.source_file_id = sf.id
       WHERE cs.bound_body_hash IS NOT NULL
         AND s.body_hash IS NOT NULL
         AND cs.bound_body_hash != s.body_hash`,
    )
    .all();
}

export function deleteConceptSymbol(db: Database, conceptId: string, symbolId: string): boolean {
  const result = db.run(`DELETE FROM concept_symbols WHERE concept_id = ? AND symbol_id = ?`, [
    conceptId,
    symbolId,
  ]);
  return (result.changes ?? 0) > 0;
}

export function deleteBindingsForConcept(db: Database, conceptId: string): void {
  db.run(`DELETE FROM concept_symbols WHERE concept_id = ?`, [conceptId]);
}

export function getBindingSummariesForConcept(
  db: Database,
  conceptId: string,
): ConceptBindingSummary[] {
  return db
    .query<ConceptBindingSummary, [string]>(
      `SELECT s.name AS symbol_name, s.qualified_name AS symbol_qualified_name,
              s.kind AS symbol_kind, sf.file_path, s.line_start,
              cs.binding_type, cs.confidence
       FROM concept_symbols cs
       JOIN symbols s ON cs.symbol_id = s.id
       JOIN source_files sf ON s.source_file_id = sf.id
       WHERE cs.concept_id = ?
       ORDER BY sf.file_path, s.line_start`,
    )
    .all(conceptId);
}

export function pruneOrphanedBindings(db: Database): number {
  // Remove bindings where the symbol no longer exists
  const result = db.run(
    `DELETE FROM concept_symbols WHERE symbol_id NOT IN (SELECT id FROM symbols)`,
  );
  // Also remove bindings where the concept is no longer active
  const result2 = db.run(
    `DELETE FROM concept_symbols WHERE concept_id NOT IN (SELECT id FROM current_concepts)`,
  );
  return (result.changes ?? 0) + (result2.changes ?? 0);
}

export function getBindingCounts(db: Database): { ref: number; mention: number; total: number } {
  const row = db
    .query<{ ref_count: number; mention_count: number; total: number }, []>(
      `SELECT
         SUM(CASE WHEN binding_type = 'ref' THEN 1 ELSE 0 END) AS ref_count,
         SUM(CASE WHEN binding_type = 'mention' THEN 1 ELSE 0 END) AS mention_count,
         COUNT(*) AS total
       FROM concept_symbols`,
    )
    .get();
  return {
    ref: row?.ref_count ?? 0,
    mention: row?.mention_count ?? 0,
    total: row?.total ?? 0,
  };
}

// ─── Coverage Queries ────────────────────────────────────

export interface GetUncoveredSymbolsOpts {
  exportedOnly?: boolean;
  filePath?: string;
  limit?: number;
}

export function getUncoveredSymbols(
  db: Database,
  opts?: GetUncoveredSymbolsOpts,
): UncoveredSymbol[] {
  const exportedOnly = opts?.exportedOnly ?? false;
  const limit = opts?.limit ?? 200;

  const conditions = [`s.id NOT IN (SELECT symbol_id FROM concept_symbols)`];
  const params: (string | number)[] = [];

  if (exportedOnly) {
    conditions.push(`s.export_status IN ('exported', 'default_export')`);
  }
  if (opts?.filePath) {
    conditions.push(`sf.file_path = ?`);
    params.push(opts.filePath);
  }

  params.push(limit);

  const sql = `
    SELECT s.id AS symbol_id, s.name, s.qualified_name, s.kind,
           s.line_start, s.export_status, sf.file_path, sf.language
    FROM symbols s
    JOIN source_files sf ON s.source_file_id = sf.id
    WHERE ${conditions.join(" AND ")}
    ORDER BY sf.file_path, s.line_start
    LIMIT ?
  `;

  const rows = db
    .query<
      {
        symbol_id: string;
        name: string;
        qualified_name: string;
        kind: string;
        line_start: number;
        export_status: string | null;
        file_path: string;
        language: string;
      },
      (string | number)[]
    >(sql)
    .all(...params);

  return rows.map((r) => ({
    symbol_id: r.symbol_id,
    name: r.name,
    qualified_name: r.qualified_name,
    kind: r.kind as SymbolKind,
    file_path: r.file_path,
    language: r.language as SupportedLanguage,
    line_start: r.line_start,
    export_status: r.export_status as UncoveredSymbol["export_status"],
  }));
}

export function getFileCoverage(db: Database): FileCoverageRow[] {
  const rows = db
    .query<
      {
        file_path: string;
        language: string;
        symbol_count: number;
        bound_count: number;
      },
      []
    >(
      `SELECT sf.file_path, sf.language, sf.symbol_count,
              (SELECT COUNT(*) FROM symbols s2
               JOIN concept_symbols cs ON cs.symbol_id = s2.id
               WHERE s2.source_file_id = sf.id) AS bound_count
       FROM source_files sf
       WHERE sf.symbol_count > 0
       ORDER BY CAST(bound_count AS REAL) / sf.symbol_count ASC`,
    )
    .all();

  return rows.map((r) => ({
    file_path: r.file_path,
    language: r.language as SupportedLanguage,
    symbol_count: r.symbol_count,
    bound_count: r.bound_count,
    coverage_ratio: r.symbol_count > 0 ? r.bound_count / r.symbol_count : 0,
  }));
}

export function getFilesForConcept(db: Database, conceptId: string): string[] {
  try {
    const rows = db
      .query<{ file_path: string }, [string]>(
        `SELECT DISTINCT sf.file_path FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id = ?`,
      )
      .all(conceptId);
    return rows.map((r) => r.file_path);
  } catch {
    return [];
  }
}

export interface ConceptSymbolLineRange {
  symbol_id: string;
  file_path: string;
  symbol_name: string;
  qualified_name: string;
  kind: SymbolKind;
  line_start: number;
  line_end: number;
  signature: string | null;
  confidence: number;
}

export function getSymbolLinesForConcept(
  db: Database,
  conceptId: string,
): ConceptSymbolLineRange[] {
  try {
    return db
      .query<ConceptSymbolLineRange, [string]>(
        `SELECT cs.symbol_id, sf.file_path, s.name AS symbol_name, s.qualified_name, s.kind,
                s.line_start, s.line_end, s.signature, cs.confidence
         FROM concept_symbols cs
         JOIN symbols s ON cs.symbol_id = s.id
         JOIN source_files sf ON s.source_file_id = sf.id
         WHERE cs.concept_id = ?
         ORDER BY sf.file_path, s.line_start`,
      )
      .all(conceptId);
  } catch {
    return [];
  }
}

export function getExportedFilePaths(db: Database): string[] {
  return db
    .query<{ file_path: string }, []>(
      `SELECT DISTINCT sf.file_path FROM source_files sf
       JOIN symbols s ON s.source_file_id = sf.id
       WHERE s.export_status IN ('exported', 'default_export')`,
    )
    .all()
    .map((r) => r.file_path);
}

export interface ConceptCoverageRow {
  concept_id: string;
  concept_name: string;
  bound_count: number;
  reachable_count: number;
  /** Capacity [0,1]: how much more knowledge this concept can absorb. */
  capacity: number;
}

/**
 * Per-concept coverage: bound symbol count and reachable symbol count
 * (total symbols in files bound to this concept).
 * Used to compute sink capacity — how much more knowledge each concept can absorb.
 */
export function getConceptCoverage(db: Database): ConceptCoverageRow[] {
  const rows = db
    .query<
      {
        concept_id: string;
        concept_name: string;
        bound_count: number;
        reachable_count: number;
      },
      []
    >(
      `SELECT
         c.id AS concept_id,
         c.name AS concept_name,
         COUNT(DISTINCT cs.symbol_id) AS bound_count,
         COALESCE((
           SELECT COUNT(DISTINCT s2.id)
           FROM symbols s2
           JOIN source_files sf2 ON s2.source_file_id = sf2.id
           WHERE sf2.id IN (
             SELECT DISTINCT sf3.id
             FROM concept_symbols cs3
             JOIN symbols s3 ON cs3.symbol_id = s3.id
             JOIN source_files sf3 ON s3.source_file_id = sf3.id
             WHERE cs3.concept_id = c.id
           )
         ), 0) AS reachable_count
       FROM current_concepts c
       LEFT JOIN concept_symbols cs ON cs.concept_id = c.id
       GROUP BY c.id, c.name`,
    )
    .all();

  return rows.map((r) => {
    const coverageDensity = r.reachable_count > 0 ? r.bound_count / r.reachable_count : 0;
    // Concepts with no bound symbols have reachable_count=0 — they're pure dark zones.
    // Give them max capacity.
    const capacity = r.bound_count === 0 ? 1.0 : Math.max(0, 1 - coverageDensity);
    return {
      concept_id: r.concept_id,
      concept_name: r.concept_name,
      bound_count: r.bound_count,
      reachable_count: r.reachable_count,
      capacity,
    };
  });
}

export function getCoverageStats(db: Database): CoverageStats {
  const row = db
    .query<
      {
        total_symbols: number;
        total_exported: number;
        bound_symbols: number;
        bound_exported: number;
      },
      []
    >(
      `SELECT
         (SELECT COUNT(*) FROM symbols) AS total_symbols,
         (SELECT COUNT(*) FROM symbols WHERE export_status IN ('exported', 'default_export')) AS total_exported,
         (SELECT COUNT(DISTINCT cs.symbol_id) FROM concept_symbols cs JOIN symbols s ON cs.symbol_id = s.id) AS bound_symbols,
         (SELECT COUNT(DISTINCT cs.symbol_id) FROM concept_symbols cs JOIN symbols s ON cs.symbol_id = s.id
          WHERE s.export_status IN ('exported', 'default_export')) AS bound_exported`,
    )
    .get();

  return {
    total_symbols: row?.total_symbols ?? 0,
    total_exported: row?.total_exported ?? 0,
    bound_symbols: row?.bound_symbols ?? 0,
    bound_exported: row?.bound_exported ?? 0,
  };
}
