import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ManifestRow } from "@/types/index.ts";

export function upsertManifest(
  db: Database,
  fields: Partial<Omit<ManifestRow, "version_id" | "inserted_at">>,
): void {
  const now = new Date().toISOString();
  const existing = getManifest(db);

  db.run(
    `INSERT INTO manifest (version_id, concept_graph_version, fiedler_value, debt,
       debt_trend, chunk_count, concept_count, last_integrated, last_embedded, graph_stale, inserted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      ulid(),
      fields.concept_graph_version ?? existing?.concept_graph_version ?? ulid(),
      fields.fiedler_value ?? existing?.fiedler_value ?? 0,
      fields.debt ?? existing?.debt ?? 0,
      fields.debt_trend ?? existing?.debt_trend ?? "stable",
      fields.chunk_count ?? existing?.chunk_count ?? 0,
      fields.concept_count ?? existing?.concept_count ?? 0,
      fields.last_integrated ?? existing?.last_integrated ?? null,
      fields.last_embedded ?? existing?.last_embedded ?? null,
      fields.graph_stale ?? existing?.graph_stale ?? 0,
      now,
    ],
  );
}

export function markGraphStale(db: Database): void {
  db.run(`UPDATE manifest SET graph_stale = 1 WHERE rowid = (SELECT MAX(rowid) FROM manifest)`);
}

export function getManifest(db: Database): ManifestRow | null {
  return db.query<ManifestRow, []>("SELECT * FROM current_manifest").get() ?? null;
}

export function getPreviousManifest(db: Database): ManifestRow | null {
  return (
    db
      .query<ManifestRow, []>("SELECT * FROM manifest ORDER BY rowid DESC LIMIT 1 OFFSET 1")
      .get() ?? null
  );
}
