import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { LaplacianCacheRow } from "@/types/index.ts";

export function upsertLaplacianCache(
  db: Database,
  graphVersion: string,
  fiedlerValue: number,
  eigenvalues: Float64Array,
  eigenvectors: Float64Array,
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO laplacian_cache
       (version_id, graph_version, fiedler_value, eigenvalues, eigenvectors, computed_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      graphVersion,
      fiedlerValue,
      new Uint8Array(eigenvalues.buffer),
      new Uint8Array(eigenvectors.buffer),
      now,
    ],
  );
}

export function getLaplacianCache(db: Database): LaplacianCacheRow | null {
  return (
    db
      .query<LaplacianCacheRow, []>(
        `SELECT * FROM laplacian_cache
         ORDER BY version_id DESC LIMIT 1`,
      )
      .get() ?? null
  );
}
