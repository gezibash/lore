import { dirname, join } from "path";
import type { Database } from "bun:sqlite";
import * as lancedb from "@lancedb/lancedb";
import { LoreError } from "@/types/index.ts";
import { expandCamelCase } from "@/db/symbols.ts";

/**
 * Lance-backed derived search index.
 *
 * SQLite remains the system of record (chunks, embeddings, content_fts rows,
 * lifecycle state). The Lance tables under <mind-dir>/lance/ are a disposable
 * projection of it: they are rebuilt or diffed from SQLite, never written to
 * directly by domain code, so a missing or stale index self-heals on the next
 * search rather than being a corruption state.
 *
 * Layout per mind:
 *   text_index          — { id, fl_type, text } with an FTS (BM25) index
 *   vec_<model-slug>    — { id, fl_type, vector } per embedding model
 */

/**
 * Identifiers that a word tokenizer would destroy.
 *
 * BM25 indexes tokens, and the standard tokenizer treats every non-alphanumeric
 * character as a separator — so `__module__` is indexed as the token "module",
 * which appears in 760 chunks of the httpx corpus and carries no signal, and
 * `not_found` becomes "not" + "found". The more distinctive an identifier looks
 * to a person, the more completely it dissolves. We collect those identifiers
 * verbatim into their own column, indexed with a whitespace tokenizer that
 * leaves them whole, so an exact-identifier query has something rare to match.
 */
export function extractVerbatimIdentifiers(text: string, limit = 400): string {
  const found = new Set<string>();
  for (const match of text.matchAll(/[A-Za-z0-9]*(?:_[A-Za-z0-9]+)+_*|__[A-Za-z0-9]+__/g)) {
    const token = match[0];
    // Single-underscore-free words are already safe; only keep what would split.
    if (token.length < 3 || !token.includes("_")) continue;
    found.add(token);
    if (found.size >= limit) break;
  }
  return [...found].join(" ");
}

const SYNC_TTL_MS = 5_000;
const lastSyncedAt = new Map<string, number>();
const inflightSync = new Map<string, Promise<LanceIndex>>();

export interface LanceIndex {
  dir: string;
  connection: lancedb.Connection;
}

interface EligibleTextRow {
  chunk_id: string;
  content: string;
  fl_type: string;
}

interface EligibleVecRow {
  chunk_id: string;
  fl_type: string;
  model: string;
  embedding: Uint8Array;
}

function modelSlug(model: string): string {
  return `vec_${model.replace(/[^a-zA-Z0-9]+/g, "_")}`;
}

export function lanceDirForDb(db: Database): string {
  const file = db.filename;
  if (!file || file === ":memory:") {
    throw new LoreError(
      "LANCE_INDEX_UNAVAILABLE",
      "Lance search index requires a file-backed lore database",
    );
  }
  return join(dirname(file), "lance");
}

/** Chunk eligibility mirrors the legacy vector/FTS lane guards:
 *  concept chunks must be non-superseded and belong to an active (or no) concept;
 *  journal/source/doc chunks are always eligible. */
const ELIGIBLE_TEXT_SQL = `
  SELECT f.chunk_id, f.content, c.fl_type
  FROM content_fts f
  JOIN chunks c ON c.id = f.chunk_id
  LEFT JOIN current_concepts cc ON cc.id = c.concept_id
  WHERE c.fl_type != 'chunk'
     OR (c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
         AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active'))`;

const ELIGIBLE_VEC_SQL = `
  SELECT e.chunk_id, c.fl_type, e.model, e.embedding
  FROM embeddings e
  JOIN chunks c ON c.id = e.chunk_id
  LEFT JOIN current_concepts cc ON cc.id = c.concept_id
  WHERE c.fl_type != 'chunk'
     OR (c.id NOT IN (SELECT supersedes_id FROM chunks WHERE supersedes_id IS NOT NULL)
         AND (c.concept_id IS NULL OR cc.lifecycle_status IS NULL OR cc.lifecycle_status = 'active'))`;

async function tableIds(table: lancedb.Table | null): Promise<Set<string>> {
  if (!table) return new Set();
  const rows = await table.query().select(["id"]).toArray();
  return new Set(rows.map((r) => r.id as string));
}

async function openTableOrNull(
  connection: lancedb.Connection,
  name: string,
): Promise<lancedb.Table | null> {
  const names = await connection.tableNames();
  if (!names.includes(name)) return null;
  return connection.openTable(name);
}

async function syncTextTable(db: Database, connection: lancedb.Connection): Promise<void> {
  const rows = db.query<EligibleTextRow, []>(ELIGIBLE_TEXT_SQL).all();
  const table = await openTableOrNull(connection, "text_index");

  if (rows.length === 0) {
    if (table) await connection.dropTable("text_index");
    return;
  }

  const wanted = new Map(rows.map((r) => [r.chunk_id, r]));
  const existing = await tableIds(table);

  const toAdd = rows
    .filter((r) => !existing.has(r.chunk_id))
    .map((r) => ({
      id: r.chunk_id,
      fl_type: r.fl_type,
      text: r.content,
      identifiers: extractVerbatimIdentifiers(r.content),
    }));
  const toRemove = [...existing].filter((id) => !wanted.has(id));

  if (!table) {
    const created = await connection.createTable(
      "text_index",
      rows.map((r) => ({
        id: r.chunk_id,
        fl_type: r.fl_type,
        text: r.content,
        identifiers: extractVerbatimIdentifiers(r.content),
      })),
    );
    await created.createIndex("text", { config: lancedb.Index.fts() });
    // Whitespace tokenizer, no stemming: identifiers must survive whole.
    await created.createIndex("identifiers", {
      config: lancedb.Index.fts({ baseTokenizer: "whitespace", stem: false, removeStopWords: false }),
    });
    return;
  }

  if (toRemove.length > 0) {
    const list = toRemove.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
    await table.delete(`id IN (${list})`);
  }
  if (toAdd.length > 0) {
    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(toAdd);
  }
}

async function syncVecTables(db: Database, connection: lancedb.Connection): Promise<void> {
  const rows = db.query<EligibleVecRow, []>(ELIGIBLE_VEC_SQL).all();
  const byModel = new Map<string, EligibleVecRow[]>();
  for (const row of rows) {
    const group = byModel.get(row.model);
    if (group) group.push(row);
    else byModel.set(row.model, [row]);
  }

  const names = await connection.tableNames();
  const wantedTables = new Set([...byModel.keys()].map(modelSlug));
  for (const name of names) {
    if (name.startsWith("vec_") && !wantedTables.has(name)) {
      await connection.dropTable(name);
    }
  }

  for (const [model, group] of byModel) {
    const name = modelSlug(model);
    const table = await openTableOrNull(connection, name);
    const wanted = new Map(group.map((r) => [r.chunk_id, r]));
    const existing = await tableIds(table);

    const toRow = (r: EligibleVecRow) => ({
      id: r.chunk_id,
      fl_type: r.fl_type,
      vector: Array.from(
        new Float32Array(r.embedding.buffer, r.embedding.byteOffset, r.embedding.byteLength / 4),
      ),
    });

    if (!table) {
      await connection.createTable(name, group.map(toRow));
      continue;
    }

    const toRemove = [...existing].filter((id) => !wanted.has(id));
    if (toRemove.length > 0) {
      const list = toRemove.map((id) => `'${id.replace(/'/g, "''")}'`).join(",");
      await table.delete(`id IN (${list})`);
    }
    const toAdd = group.filter((r) => !existing.has(r.chunk_id)).map(toRow);
    if (toAdd.length > 0) {
      await table
        .mergeInsert("id")
        .whenMatchedUpdateAll()
        .whenNotMatchedInsertAll()
        .execute(toAdd);
    }
  }
}

/**
 * Open the mind's Lance index, healing any drift from SQLite first.
 * Cheap when in sync (id-set diff); throttled by a short TTL so the
 * two hybridSearch calls within one ask pay for at most one sync.
 */
export async function ensureLanceIndex(db: Database): Promise<LanceIndex> {
  const dir = lanceDirForDb(db);

  const last = lastSyncedAt.get(dir);
  if (last !== undefined && Date.now() - last < SYNC_TTL_MS) {
    const connection = await lancedb.connect(dir);
    return { dir, connection };
  }

  const pending = inflightSync.get(dir);
  if (pending) return pending;

  const task = (async () => {
    const connection = await lancedb.connect(dir);
    await syncTextTable(db, connection);
    await syncVecTables(db, connection);
    lastSyncedAt.set(dir, Date.now());
    return { dir, connection };
  })();
  inflightSync.set(dir, task);
  try {
    return await task;
  } finally {
    inflightSync.delete(dir);
  }
}

/** Invalidate the sync TTL so the next search re-diffs against SQLite immediately.
 *  Call after any write that adds or removes chunks/embeddings. */
export function markLanceDirty(db: Database): void {
  try {
    lastSyncedAt.delete(lanceDirForDb(db));
  } catch {
    // :memory: db — nothing to invalidate
  }
}

/** Drop all Lance tables and resync from SQLite. For paths that mutate rows
 *  in place (embeddings refresh, rebuild) where an id-set diff cannot see the change. */
export async function rebuildLanceIndex(db: Database): Promise<void> {
  const dir = lanceDirForDb(db);
  const connection = await lancedb.connect(dir);
  for (const name of await connection.tableNames()) {
    await connection.dropTable(name);
  }
  lastSyncedAt.delete(dir);
  await syncTextTable(db, connection);
  await syncVecTables(db, connection);
  lastSyncedAt.set(dir, Date.now());
}

export async function lanceVectorSearch(
  index: LanceIndex,
  queryEmbedding: Float32Array,
  opts: { flType: "chunk" | "journal" | "source" | "doc"; model?: string; limit: number },
): Promise<{ chunkId: string; distance: number }[]> {
  let tableName: string | null = null;
  if (opts.model) {
    tableName = modelSlug(opts.model);
  } else {
    // No model filter: legacy behavior searched across all models; search every
    // vec table whose dimension matches and merge by best distance.
    const names = (await index.connection.tableNames()).filter((n) => n.startsWith("vec_"));
    if (names.length === 1) tableName = names[0]!;
    else if (names.length > 1) {
      const merged = new Map<string, number>();
      for (const name of names) {
        for (const hit of await searchOneVecTable(index, name, queryEmbedding, opts)) {
          const current = merged.get(hit.chunkId);
          if (current === undefined || hit.distance < current) merged.set(hit.chunkId, hit.distance);
        }
      }
      return [...merged.entries()]
        .map(([chunkId, distance]) => ({ chunkId, distance }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, opts.limit);
    }
  }
  if (!tableName) return [];
  return searchOneVecTable(index, tableName, queryEmbedding, opts);
}

async function searchOneVecTable(
  index: LanceIndex,
  tableName: string,
  queryEmbedding: Float32Array,
  opts: { flType: string; limit: number },
): Promise<{ chunkId: string; distance: number }[]> {
  const table = await openTableOrNull(index.connection, tableName);
  if (!table) return [];
  try {
    const rows = await table
      .vectorSearch(queryEmbedding)
      .distanceType("cosine")
      .where(`fl_type = '${opts.flType}'`)
      .limit(opts.limit)
      .toArray();
    return rows.map((r) => ({ chunkId: r.id as string, distance: r._distance as number }));
  } catch {
    // Dimension mismatch (query embedded with a different model than this table) — skip lane.
    return [];
  }
}

export async function lanceBm25Search(
  index: LanceIndex,
  query: string,
  opts: { flType: "chunk" | "journal" | "source" | "doc"; limit: number },
): Promise<{ chunkId: string }[]> {
  const table = await openTableOrNull(index.connection, "text_index");
  if (!table) return [];
  const expanded = expandCamelCase(query);

  const search = async (text: string, column?: string) => {
    try {
      const builder = table
        .query()
        .fullTextSearch(text, column ? { columns: column } : undefined)
        .where(`fl_type = '${opts.flType}'`)
        .limit(opts.limit);
      const rows = await builder.toArray();
      return rows.map((r) => ({ chunkId: r.id as string }));
    } catch {
      return [];
    }
  };

  const wordHits = await search(expanded);

  // Verbatim lane: when the query names an identifier a word tokenizer would
  // shred (__module__, not_found), also search the whitespace-tokenized
  // identifiers column, where it is still one rare term. Those hits lead —
  // an exact identifier match is the strongest signal there is.
  const queryIdentifiers = extractVerbatimIdentifiers(query, 8);
  if (!queryIdentifiers) return wordHits;

  const identifierHits = await search(queryIdentifiers, "identifiers");
  if (identifierHits.length === 0) return wordHits;

  const seen = new Set(identifierHits.map((h) => h.chunkId));
  return [...identifierHits, ...wordHits.filter((h) => !seen.has(h.chunkId))].slice(0, opts.limit);
}
