import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ConceptSnapshotRow } from "@/types/index.ts";

export function insertSnapshot(
  db: Database,
  conceptId: string,
  narrativeId: string,
  embeddingId: string,
): string {
  const id = ulid();
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO concept_snapshots (id, concept_id, narrative_id, embedding_id, captured_at)
     VALUES (?, ?, ?, ?, ?)`,
    [id, conceptId, narrativeId, embeddingId, now],
  );
  return id;
}

export function getSnapshotsForNarrative(db: Database, narrativeId: string): ConceptSnapshotRow[] {
  return db
    .query<ConceptSnapshotRow, [string]>("SELECT * FROM concept_snapshots WHERE narrative_id = ?")
    .all(narrativeId);
}

export function deleteSnapshotsForNarratives(db: Database): void {
  db.run("DELETE FROM concept_snapshots");
}
