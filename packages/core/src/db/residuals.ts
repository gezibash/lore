import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ResidualHistoryRow } from "@/types/index.ts";

export function insertResidualHistory(
  db: Database,
  conceptId: string,
  residual: number,
  debtTotal: number,
): string {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO residual_history (id, concept_id, residual, debt_total, recorded_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, conceptId, residual, debtTotal, now],
  );
  return id;
}

export function getResidualHistory(
  db: Database,
  conceptId: string,
  limit: number = 50,
): ResidualHistoryRow[] {
  return db
    .query<ResidualHistoryRow, [string, number]>(
      `SELECT * FROM residual_history
       WHERE concept_id = ?
       ORDER BY recorded_at DESC LIMIT ?`,
    )
    .all(conceptId, limit);
}

export function getLatestDebt(db: Database): number {
  const row = db
    .query<{ debt_total: number }, []>(
      `SELECT debt_total FROM residual_history
       ORDER BY recorded_at DESC LIMIT 1`,
    )
    .get();
  return row?.debt_total ?? 0;
}

export function deleteAllResidualHistory(db: Database): void {
  db.run("DELETE FROM residual_history");
}
