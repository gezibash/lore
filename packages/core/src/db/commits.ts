import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { CommitRow, CommitTreeRow, LifecycleEventType, TreeDiff } from "@/types/index.ts";

export function insertCommit(
  db: Database,
  deltaId: string | null,
  parentId: string | null,
  mergeBaseId: string | null,
  message: string,
): CommitRow {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO commits (id, narrative_id, parent_id, merge_base_id, message, committed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, deltaId, parentId, mergeBaseId, message, now],
  );
  return {
    id,
    narrative_id: deltaId,
    parent_id: parentId,
    merge_base_id: mergeBaseId,
    message,
    committed_at: now,
  };
}

export function insertCommitTree(
  db: Database,
  commitId: string,
  entries: Array<{ conceptId: string; chunkId: string; conceptName?: string }>,
): void {
  const stmt = db.prepare(
    `INSERT INTO commit_tree (commit_id, concept_id, chunk_id, concept_name) VALUES (?, ?, ?, ?)`,
  );
  for (const entry of entries) {
    stmt.run(commitId, entry.conceptId, entry.chunkId, entry.conceptName ?? null);
  }
}

export function getCommit(db: Database, id: string): CommitRow | null {
  return db.query<CommitRow, [string]>("SELECT * FROM commits WHERE id = ?").get(id) ?? null;
}

export function getHeadCommit(db: Database): CommitRow | null {
  return (
    db
      .query<CommitRow, []>("SELECT * FROM commits ORDER BY committed_at DESC, id DESC LIMIT 1")
      .get() ?? null
  );
}

export function getCommitTree(db: Database, commitId: string): CommitTreeRow[] {
  return db
    .query<CommitTreeRow, [string]>("SELECT * FROM commit_tree WHERE commit_id = ?")
    .all(commitId);
}

export function getCommitTreeAsMap(db: Database, commitId: string): Map<string, string> {
  const rows = getCommitTree(db, commitId);
  const map = new Map<string, string>();
  for (const row of rows) {
    map.set(row.concept_id, row.chunk_id);
  }
  return map;
}

export function walkHistory(db: Database, startId?: string, limit: number = 50): CommitRow[] {
  if (startId) {
    // Walk backwards from a specific commit
    const commits: CommitRow[] = [];
    let current: CommitRow | null = getCommit(db, startId);
    while (current && commits.length < limit) {
      commits.push(current);
      if (!current.parent_id) break;
      current = getCommit(db, current.parent_id);
    }
    return commits;
  }
  // Walk from HEAD
  return db.query<CommitRow, [number]>("SELECT * FROM commits ORDER BY id DESC LIMIT ?").all(limit);
}

export function diffCommitTrees(db: Database, fromId: string, toId: string): TreeDiff {
  const fromTree = getCommitTreeAsMap(db, fromId);
  const toTree = getCommitTreeAsMap(db, toId);

  // Build concept name lookup per commit, preferring commit-time snapshots.
  const loadNamesForCommit = (commitId: string): Map<string, string> => {
    const conceptNames = new Map<string, string>();
    const rows = db
      .query<{ concept_id: string; concept_name: string | null }, [string]>(
        `SELECT concept_id, concept_name
         FROM commit_tree
         WHERE commit_id = ?`,
      )
      .all(commitId);

    for (const row of rows) {
      if (row.concept_name) {
        conceptNames.set(row.concept_id, row.concept_name);
      }
    }

    const unresolved = rows.map((r) => r.concept_id).filter((id) => !conceptNames.has(id));
    if (unresolved.length > 0) {
      const placeholders = unresolved.map(() => "?").join(", ");
      const fallbackRows = db
        .query<{ id: string; name: string }, string[]>(
          `SELECT id, name FROM current_concepts WHERE id IN (${placeholders})`,
        )
        .all(...unresolved);
      for (const row of fallbackRows) {
        conceptNames.set(row.id, row.name);
      }
    }
    return conceptNames;
  };
  const fromNames = loadNamesForCommit(fromId);
  const toNames = loadNamesForCommit(toId);

  const added: TreeDiff["added"] = [];
  const removed: TreeDiff["removed"] = [];
  const modified: TreeDiff["modified"] = [];

  // Find removed and modified
  for (const [conceptId, fromChunkId] of fromTree) {
    const toChunkId = toTree.get(conceptId);
    if (!toChunkId) {
      removed.push({
        conceptName: fromNames.get(conceptId) ?? toNames.get(conceptId) ?? conceptId,
        chunkId: fromChunkId,
      });
    } else if (toChunkId !== fromChunkId) {
      const fromName = fromNames.get(conceptId);
      const toName = toNames.get(conceptId);
      const conceptName =
        fromName && toName && fromName !== toName
          ? `${fromName} -> ${toName}`
          : (toName ?? fromName ?? conceptId);
      modified.push({
        conceptName,
        fromChunkId,
        toChunkId,
      });
    }
  }

  // Find added
  for (const [conceptId, chunkId] of toTree) {
    if (!fromTree.has(conceptId)) {
      added.push({
        conceptName: toNames.get(conceptId) ?? fromNames.get(conceptId) ?? conceptId,
        chunkId,
      });
    }
  }

  return { added, removed, modified };
}

/**
 * Resolve a ref string to a commit.
 * Supports: bare ULID, "main~N" (N commits back), "main@YYYY-MM-DD" (first commit on/after date),
 * duration shorthand (2w, 3d, 12h, 30m).
 */
export function resolveRef(db: Database, ref: string): CommitRow | null {
  // Bare ULID
  if (/^[0-9A-Z]{26}$/i.test(ref)) {
    return getCommit(db, ref.toUpperCase());
  }

  // Duration shorthand: 2w, 3d, 12h, 30m
  const durationMatch = ref.match(/^(\d+)([wdhm])$/);
  if (durationMatch) {
    const n = parseInt(durationMatch[1]!, 10);
    const unit = durationMatch[2]!;
    const msPerUnit: Record<string, number> = {
      w: 7 * 24 * 60 * 60 * 1000,
      d: 24 * 60 * 60 * 1000,
      h: 60 * 60 * 1000,
      m: 60 * 1000,
    };
    const since = new Date(Date.now() - n * msPerUnit[unit]!).toISOString();
    return (
      db
        .query<CommitRow, [string]>(
          "SELECT * FROM commits WHERE committed_at >= ? ORDER BY committed_at ASC LIMIT 1",
        )
        .get(since) ?? null
    );
  }

  // main~N
  const tildeMatch = ref.match(/^main~(\d+)$/);
  if (tildeMatch) {
    const n = parseInt(tildeMatch[1]!, 10);
    let current = getHeadCommit(db);
    for (let i = 0; i < n && current?.parent_id; i++) {
      current = getCommit(db, current.parent_id);
    }
    return current;
  }

  // main@YYYY-MM-DD
  const dateMatch = ref.match(/^main@(\d{4}-\d{2}-\d{2})$/);
  if (dateMatch) {
    const date = dateMatch[1]!;
    return (
      db
        .query<CommitRow, [string]>(
          "SELECT * FROM commits WHERE committed_at >= ? ORDER BY committed_at ASC LIMIT 1",
        )
        .get(date) ?? null
    );
  }

  // "main" = HEAD
  if (ref === "main") {
    return getHeadCommit(db);
  }

  return null;
}

export function parseLifecycleMessage(
  message: string,
): { type: LifecycleEventType; description: string } | null {
  const match = message.match(/^lifecycle:\s+(archive|restore|rename|merge|split|patch)\s+(.+)$/);
  if (!match) return null;
  return { type: match[1] as LifecycleEventType, description: match[2]! };
}
