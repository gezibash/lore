import type { Database } from "bun:sqlite";
import type { CallSiteRow } from "@/types/index.ts";
import { ulid } from "ulid";

export interface InsertCallSiteOpts {
  callee_name: string;
  caller_name: string | null;
  line: number;
  snippet: string | null;
}

export function insertCallSiteBatch(
  db: Database,
  sourceFileId: string,
  sites: InsertCallSiteOpts[],
): void {
  if (sites.length === 0) return;
  const now = new Date().toISOString();
  const stmt = db.prepare(
    `INSERT INTO call_sites (id, source_file_id, callee_name, caller_name, line, snippet, scanned_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const s of sites) {
    stmt.run(ulid(), sourceFileId, s.callee_name, s.caller_name, s.line, s.snippet, now);
  }
}

export function deleteCallSitesForSourceFile(db: Database, sourceFileId: string): void {
  db.run(`DELETE FROM call_sites WHERE source_file_id = ?`, [sourceFileId]);
}

export function getCallSitesForCallee(
  db: Database,
  calleeName: string,
  opts?: { limit?: number },
): (CallSiteRow & { file_path: string })[] {
  const limit = opts?.limit ?? 5;
  return db
    .query<CallSiteRow & { file_path: string }, [string, number]>(
      `SELECT cs.*, sf.file_path
       FROM call_sites cs
       JOIN source_files sf ON cs.source_file_id = sf.id
       WHERE cs.callee_name = ?
       ORDER BY cs.line
       LIMIT ?`,
    )
    .all(calleeName, limit);
}

export function getCallSitesInFile(db: Database, sourceFileId: string): CallSiteRow[] {
  return db
    .query<CallSiteRow, [string]>(`SELECT * FROM call_sites WHERE source_file_id = ? ORDER BY line`)
    .all(sourceFileId);
}

export function getCallSitesByCaller(
  db: Database,
  callerName: string,
  opts?: { limit?: number },
): (CallSiteRow & { file_path: string })[] {
  const limit = opts?.limit ?? 5;
  return db
    .query<CallSiteRow & { file_path: string }, [string, number]>(
      `SELECT cs.*, sf.file_path
       FROM call_sites cs
       JOIN source_files sf ON cs.source_file_id = sf.id
       WHERE cs.caller_name = ?
       ORDER BY cs.line
       LIMIT ?`,
    )
    .all(callerName, limit);
}

export function getCallSiteCount(db: Database): number {
  return (
    db.query<{ count: number }, []>(`SELECT COUNT(*) as count FROM call_sites`).get()?.count ?? 0
  );
}
