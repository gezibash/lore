import type { Database } from "bun:sqlite";
import { buildCanonicalSchemaFromMigrations } from "./schema-canonical.ts";
import { inspectSchema, type SchemaColumn, type SchemaSnapshot } from "./schema-inspect.ts";
import { migrate } from "./migrator.ts";

export type SchemaIssueKind =
  | "missing_table"
  | "missing_view"
  | "missing_index"
  | "missing_column"
  | "definition_mismatch"
  | "history_mismatch"
  | "migration_error"
  | "pending_migration";

export interface SchemaIssue {
  kind: SchemaIssueKind;
  name: string;
  detail?: string;
}

export interface SchemaRepairOptions {
  check?: boolean;
}

export interface SchemaRepairResult {
  mode: "check" | "apply";
  ok: boolean;
  canonical_target: {
    migration_names: string[];
    migration_digest: string;
  };
  migrations_applied: number;
  migrations_reconciled: number;
  issues_found: SchemaIssue[];
  fixed: SchemaIssue[];
  remaining: SchemaIssue[];
}

interface MigrationLedgerReport {
  appliedNames: string[];
  pendingNames: string[];
  historyIssues: SchemaIssue[];
}

interface AuditReport {
  schemaIssues: SchemaIssue[];
  historyIssues: SchemaIssue[];
  pendingIssues: SchemaIssue[];
  pendingNames: string[];
  issues: SchemaIssue[];
}

function quoteSqliteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function issueKey(issue: SchemaIssue): string {
  return `${issue.kind}:${issue.name}`;
}

function dedupeIssues(issues: SchemaIssue[]): SchemaIssue[] {
  const seen = new Set<string>();
  const out: SchemaIssue[] = [];
  for (const issue of issues) {
    const key = `${issueKey(issue)}:${issue.detail ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

function sameColumnDefinition(a: SchemaColumn, b: SchemaColumn): boolean {
  const normType = (value: string) => value.trim().toLowerCase();
  const normDefault = (value: string | null) => (value == null ? null : value.trim().toLowerCase());
  return (
    normType(a.type) === normType(b.type) &&
    a.notNull === b.notNull &&
    a.isPrimaryKey === b.isPrimaryKey &&
    normDefault(a.defaultValue) === normDefault(b.defaultValue)
  );
}

function diffSchemaAgainstCanonical(
  live: SchemaSnapshot,
  canonical: SchemaSnapshot,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];

  for (const [tableName, expected] of canonical.tables) {
    const actual = live.tables.get(tableName);
    if (!actual) {
      issues.push({ kind: "missing_table", name: tableName });
      continue;
    }
    if (actual.normalizedSql !== expected.normalizedSql) {
      issues.push({
        kind: "definition_mismatch",
        name: tableName,
        detail: "table SQL differs from canonical migration-derived schema",
      });
    }

    const expectedColumns = canonical.columnsByTable.get(tableName) ?? new Map();
    const actualColumns = live.columnsByTable.get(tableName) ?? new Map();
    for (const [columnName, expectedColumn] of expectedColumns) {
      const actualColumn = actualColumns.get(columnName);
      if (!actualColumn) {
        issues.push({ kind: "missing_column", name: `${tableName}.${columnName}` });
        continue;
      }
      if (!sameColumnDefinition(actualColumn, expectedColumn)) {
        issues.push({
          kind: "definition_mismatch",
          name: `${tableName}.${columnName}`,
          detail: "column definition differs from canonical migration-derived schema",
        });
      }
    }
  }

  for (const [viewName, expected] of canonical.views) {
    const actual = live.views.get(viewName);
    if (!actual) {
      issues.push({ kind: "missing_view", name: viewName });
      continue;
    }
    if (actual.normalizedSql !== expected.normalizedSql) {
      issues.push({
        kind: "definition_mismatch",
        name: viewName,
        detail: "view SQL differs from canonical migration-derived schema",
      });
    }
  }

  for (const [indexName, expected] of canonical.indexes) {
    const actual = live.indexes.get(indexName);
    if (!actual) {
      issues.push({ kind: "missing_index", name: indexName });
      continue;
    }
    if (actual.normalizedSql !== expected.normalizedSql) {
      issues.push({
        kind: "definition_mismatch",
        name: indexName,
        detail: "index SQL differs from canonical migration-derived schema",
      });
    }
  }

  return dedupeIssues(issues);
}

function migrationLedgerTableExists(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      `SELECT name
       FROM sqlite_master
       WHERE type = 'table' AND name = '_migrations'`,
    )
    .get();
  return row != null;
}

function ensureMigrationsTable(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name       TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL
  )`);
}

function inspectMigrationLedger(db: Database, canonicalNames: string[]): MigrationLedgerReport {
  if (!migrationLedgerTableExists(db)) {
    return {
      appliedNames: [],
      pendingNames: [...canonicalNames],
      historyIssues: [],
    };
  }

  const rows = db.query<{ name: string }, []>("SELECT name FROM _migrations ORDER BY name").all();
  const appliedNames = rows.map((row) => row.name);
  const canonicalSet = new Set(canonicalNames);
  const appliedSet = new Set(appliedNames);

  const historyIssues: SchemaIssue[] = [];
  for (const name of appliedNames) {
    if (!canonicalSet.has(name)) {
      historyIssues.push({
        kind: "history_mismatch",
        name,
        detail: "recorded as applied but migration file is missing",
      });
    }
  }

  const pendingNames = canonicalNames.filter((name) => !appliedSet.has(name));
  return {
    appliedNames,
    pendingNames,
    historyIssues,
  };
}

function auditAgainstCanonical(
  db: Database,
  canonical: ReturnType<typeof buildCanonicalSchemaFromMigrations>,
): AuditReport {
  const live = inspectSchema(db);
  const schemaIssues = diffSchemaAgainstCanonical(live, canonical);
  const ledger = inspectMigrationLedger(db, canonical.migrationNames);
  const pendingIssues = ledger.pendingNames.map((name) => ({
    kind: "pending_migration" as const,
    name,
  }));

  const issues = dedupeIssues([...schemaIssues, ...ledger.historyIssues, ...pendingIssues]);

  return {
    schemaIssues,
    historyIssues: ledger.historyIssues,
    pendingIssues,
    pendingNames: ledger.pendingNames,
    issues,
  };
}

function buildAddColumnSql(tableName: string, column: SchemaColumn): string {
  const parts: string[] = [quoteSqliteIdentifier(column.name)];
  if (column.type.trim().length > 0) {
    parts.push(column.type);
  }
  if (column.notNull) {
    parts.push("NOT NULL");
  }
  if (column.defaultValue != null) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }

  return `ALTER TABLE ${quoteSqliteIdentifier(tableName)} ADD COLUMN ${parts.join(" ")}`;
}

function applySchemaFixes(
  db: Database,
  canonical: ReturnType<typeof buildCanonicalSchemaFromMigrations>,
  report: AuditReport,
): { fixed: SchemaIssue[]; errors: SchemaIssue[] } {
  const fixed: SchemaIssue[] = [];
  const errors: SchemaIssue[] = [];

  const missingTableNames = report.schemaIssues
    .filter((i) => i.kind === "missing_table")
    .map((i) => i.name);
  for (const name of missingTableNames) {
    const object = canonical.tables.get(name);
    if (!object) continue;
    try {
      db.exec(object.sql);
      fixed.push({ kind: "missing_table", name });
    } catch (error) {
      errors.push({
        kind: "migration_error",
        name: `create_table:${name}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const postTableReport = auditAgainstCanonical(db, canonical);
  const missingColumnNames = postTableReport.schemaIssues
    .filter((i) => i.kind === "missing_column")
    .map((i) => i.name);
  for (const path of missingColumnNames) {
    const [tableName, columnName] = path.split(".", 2);
    if (!tableName || !columnName) continue;
    const column = canonical.columnsByTable.get(tableName)?.get(columnName);
    if (!column) continue;
    try {
      db.exec(buildAddColumnSql(tableName, column));
      fixed.push({ kind: "missing_column", name: path });
    } catch (error) {
      errors.push({
        kind: "migration_error",
        name: `add_column:${path}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const postColumnReport = auditAgainstCanonical(db, canonical);
  const missingViewNames = postColumnReport.schemaIssues
    .filter((i) => i.kind === "missing_view")
    .map((i) => i.name);
  for (const name of missingViewNames) {
    const object = canonical.views.get(name);
    if (!object) continue;
    try {
      db.exec(object.sql);
      fixed.push({ kind: "missing_view", name });
    } catch (error) {
      errors.push({
        kind: "migration_error",
        name: `create_view:${name}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const postViewReport = auditAgainstCanonical(db, canonical);
  const missingIndexNames = postViewReport.schemaIssues
    .filter((i) => i.kind === "missing_index")
    .map((i) => i.name);
  for (const name of missingIndexNames) {
    const object = canonical.indexes.get(name);
    if (!object) continue;
    try {
      db.exec(object.sql);
      fixed.push({ kind: "missing_index", name });
    } catch (error) {
      errors.push({
        kind: "migration_error",
        name: `create_index:${name}`,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { fixed: dedupeIssues(fixed), errors: dedupeIssues(errors) };
}

function reconcileMigrationLedger(
  db: Database,
  pendingNames: string[],
): { reconciled: number; fixed: SchemaIssue[] } {
  if (pendingNames.length === 0) return { reconciled: 0, fixed: [] };

  ensureMigrationsTable(db);
  let reconciled = 0;
  const fixed: SchemaIssue[] = [];
  for (const name of pendingNames) {
    db.exec(
      `INSERT INTO _migrations (name, applied_at) VALUES ('${name}', '${new Date().toISOString()}')`,
    );
    reconciled++;
    fixed.push({ kind: "pending_migration", name });
  }

  return { reconciled, fixed };
}

export function describeSchemaIssue(issue: SchemaIssue): string {
  switch (issue.kind) {
    case "missing_table":
      return `Missing table '${issue.name}'`;
    case "missing_view":
      return `Missing view '${issue.name}'`;
    case "missing_index":
      return `Missing index '${issue.name}'`;
    case "missing_column":
      return `Missing column '${issue.name}'`;
    case "definition_mismatch":
      return `Definition mismatch for '${issue.name}'`;
    case "history_mismatch":
      return `Migration history mismatch for '${issue.name}'`;
    case "migration_error":
      return `Migration error: ${issue.detail ?? issue.name}`;
    case "pending_migration":
      return `Pending migration '${issue.name}'`;
    default:
      return issue.name;
  }
}

export function auditSchema(db: Database): SchemaIssue[] {
  const canonical = buildCanonicalSchemaFromMigrations();
  return auditAgainstCanonical(db, canonical).issues;
}

export function repairSchema(db: Database, opts?: SchemaRepairOptions): SchemaRepairResult {
  const mode = opts?.check ? "check" : "apply";
  const canonical = buildCanonicalSchemaFromMigrations();

  if (mode === "check") {
    const audit = auditAgainstCanonical(db, canonical);
    return {
      mode,
      ok: audit.issues.length === 0,
      canonical_target: {
        migration_names: canonical.migrationNames,
        migration_digest: canonical.migrationDigest,
      },
      migrations_applied: 0,
      migrations_reconciled: 0,
      issues_found: audit.issues,
      fixed: [],
      remaining: audit.issues,
    };
  }

  let migrationsApplied = 0;
  let migrationsReconciled = 0;
  const fixed: SchemaIssue[] = [];
  const unresolvedErrors: SchemaIssue[] = [];
  const issuesFound: SchemaIssue[] = [];

  const initialAudit = auditAgainstCanonical(db, canonical);
  issuesFound.push(...initialAudit.issues);

  if (initialAudit.schemaIssues.length === 0 && initialAudit.pendingNames.length > 0) {
    const reconciled = reconcileMigrationLedger(db, initialAudit.pendingNames);
    migrationsReconciled += reconciled.reconciled;
    fixed.push(...reconciled.fixed);

    const finalAudit = auditAgainstCanonical(db, canonical);
    return {
      mode,
      ok: finalAudit.issues.length === 0,
      canonical_target: {
        migration_names: canonical.migrationNames,
        migration_digest: canonical.migrationDigest,
      },
      migrations_applied: migrationsApplied,
      migrations_reconciled: migrationsReconciled,
      issues_found: dedupeIssues(issuesFound),
      fixed: dedupeIssues(fixed),
      remaining: finalAudit.issues,
    };
  }

  try {
    migrationsApplied += migrate(db);
  } catch (error) {
    const issue: SchemaIssue = {
      kind: "migration_error",
      name: "migrate:initial",
      detail: error instanceof Error ? error.message : String(error),
    };
    issuesFound.push(issue);
  }

  const postInitialMigrateAudit = auditAgainstCanonical(db, canonical);
  issuesFound.push(...postInitialMigrateAudit.issues);

  const schemaFixes = applySchemaFixes(db, canonical, postInitialMigrateAudit);
  fixed.push(...schemaFixes.fixed);
  unresolvedErrors.push(...schemaFixes.errors);
  issuesFound.push(...schemaFixes.errors);

  const preReconcileAudit = auditAgainstCanonical(db, canonical);
  if (preReconcileAudit.schemaIssues.length > 0 && preReconcileAudit.pendingNames.length > 0) {
    try {
      migrationsApplied += migrate(db);
    } catch (error) {
      const issue: SchemaIssue = {
        kind: "migration_error",
        name: "migrate:final",
        detail: error instanceof Error ? error.message : String(error),
      };
      unresolvedErrors.push(issue);
      issuesFound.push(issue);
    }
  }

  const preLedgerReconcileAudit = auditAgainstCanonical(db, canonical);
  if (
    preLedgerReconcileAudit.schemaIssues.length === 0 &&
    preLedgerReconcileAudit.pendingNames.length > 0
  ) {
    const reconciled = reconcileMigrationLedger(db, preLedgerReconcileAudit.pendingNames);
    migrationsReconciled += reconciled.reconciled;
    fixed.push(...reconciled.fixed);
  }

  const finalAudit = auditAgainstCanonical(db, canonical);
  const remaining = dedupeIssues([...finalAudit.issues, ...unresolvedErrors]);

  return {
    mode,
    ok: remaining.length === 0,
    canonical_target: {
      migration_names: canonical.migrationNames,
      migration_digest: canonical.migrationDigest,
    },
    migrations_applied: migrationsApplied,
    migrations_reconciled: migrationsReconciled,
    issues_found: dedupeIssues(issuesFound),
    fixed: dedupeIssues(fixed),
    remaining,
  };
}
