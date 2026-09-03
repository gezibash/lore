/**
 * Path scoping for retrieval.
 *
 * One mind per workspace is what makes a cross-repo answer possible, and it is
 * also what lets near-duplicate code crowd a retrieved set: two packages that
 * solve the same problem the same way both match, and the answer blurs them.
 * Splitting the workspace fixes the crowding by giving up the cross-repo
 * answers. A scope fixes it for the one question that needs it and leaves the
 * mind whole.
 */
import type { Database } from "bun:sqlite";

/** `./packages/core/` and `packages/core` mean the same directory. */
export function normalizeScope(raw: string): string {
  return raw.trim().replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `filePath` is the scope itself or sits under it.
 *
 *  The separator check is what keeps `packages/core` from claiming
 *  `packages/core-utils`, which a plain prefix test would take. */
export function isUnderScope(filePath: string, scope: string): boolean {
  if (scope === "" || scope === ".") return true;
  return filePath === scope || filePath.startsWith(`${scope}/`);
}

function anyScope(filePath: string, scopes: readonly string[]): boolean {
  return scopes.some((scope) => isUnderScope(filePath, scope));
}

/**
 * The concepts that have at least one symbol bound inside the scope.
 *
 * A concept chunk carries no path of its own — it is prose about the codebase,
 * not a piece of it — so its bindings are what place it. A concept bound to
 * `packages/core/src/auth.ts` is about that package wherever its prose lives.
 */
function conceptsInScope(db: Database, scopes: readonly string[]): Set<string> {
  const rows = db
    .query<{ concept_id: string; file_path: string }, []>(
      `SELECT DISTINCT cs.concept_id AS concept_id, sf.file_path AS file_path
         FROM concept_symbols cs
         JOIN symbols s ON s.id = cs.symbol_id
         JOIN source_files sf ON sf.id = s.source_file_id`,
    )
    .all();
  const inScope = new Set<string>();
  for (const row of rows) {
    if (anyScope(row.file_path, scopes)) inScope.add(row.concept_id);
  }
  return inScope;
}

/** Active concepts that have no binding at all, so nothing places them.
 *
 *  Archived and superseded versions must not ride along. `concepts` is
 *  append-only, so a query over it would keep a retired concept in every
 *  scoped answer. */
function unboundConcepts(db: Database): Set<string> {
  const rows = db
    .query<{ id: string }, []>(
      `SELECT c.id AS id
         FROM current_concepts c
         WHERE (c.lifecycle_status IS NULL OR c.lifecycle_status = 'active')
           AND NOT EXISTS (SELECT 1 FROM concept_symbols cs WHERE cs.concept_id = c.id)`,
    )
    .all();
  return new Set(rows.map((row) => row.id));
}

/** Keep items whose `file_path` sits inside the scope. No scope keeps all. */
export function filterItemsByScope<T extends { file_path: string }>(
  items: readonly T[],
  rawScopes: readonly string[] | undefined,
): T[] {
  const scopes = (rawScopes ?? []).map(normalizeScope).filter((scope) => scope.length > 0);
  if (scopes.length === 0) return [...items];
  return items.filter((item) => anyScope(item.file_path, scopes));
}

/**
 * Keep the chunks a scope allows.
 *
 * A chunk with a path is judged by that path. A concept chunk is judged by its
 * bindings, and a concept with no bindings is kept: nothing places it, so
 * nothing proves it is outside. Dropping it would hide a purely architectural
 * concept from every scoped question, which is a worse failure than letting one
 * through — the reader can see a concept that does not fit and cannot see one
 * that never arrived.
 */
export function filterChunkIdsByScope(
  db: Database,
  chunkIds: readonly string[],
  rawScopes: readonly string[],
): Set<string> {
  const scopes = rawScopes.map(normalizeScope).filter((scope) => scope.length > 0);
  const kept = new Set<string>();
  if (chunkIds.length === 0) return kept;
  if (scopes.length === 0) {
    for (const id of chunkIds) kept.add(id);
    return kept;
  }

  const placeholders = chunkIds.map(() => "?").join(", ");
  const rows = db
    .query<{ id: string; source_file_path: string | null; concept_id: string | null }, string[]>(
      `SELECT id, source_file_path, concept_id FROM chunks WHERE id IN (${placeholders})`,
    )
    .all(...(chunkIds as string[]));

  let conceptScope: Set<string> | null = null;
  let unbound: Set<string> | null = null;

  for (const row of rows) {
    if (row.source_file_path) {
      if (anyScope(row.source_file_path, scopes)) kept.add(row.id);
      continue;
    }
    if (!row.concept_id) {
      // A journal entry belongs to a session, not to a directory. A scope is
      // about where code lives, so it does not speak to these.
      kept.add(row.id);
      continue;
    }
    // Computed once, and only when a concept chunk actually reaches here.
    conceptScope ??= conceptsInScope(db, scopes);
    unbound ??= unboundConcepts(db);
    if (conceptScope.has(row.concept_id) || unbound.has(row.concept_id)) kept.add(row.id);
  }

  return kept;
}
