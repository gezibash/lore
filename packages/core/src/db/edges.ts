import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ConceptEdgeRow } from "@/types/index.ts";

export function insertEdge(
  db: Database,
  fromId: string,
  toId: string,
  alpha: number,
  graphVersion: string,
): void {
  const id = ulid();
  db.run(
    `INSERT INTO concept_edges (id, from_id, to_id, alpha, graph_version)
     VALUES (?, ?, ?, ?, ?)`,
    [id, fromId, toId, alpha, graphVersion],
  );
}

export function getEdges(db: Database, graphVersion?: string): ConceptEdgeRow[] {
  if (graphVersion) {
    return db
      .query<ConceptEdgeRow, [string]>("SELECT * FROM concept_edges WHERE graph_version = ?")
      .all(graphVersion);
  }
  // Fall back to latest graph version from manifest
  const row = db
    .query<{ concept_graph_version: string }, []>(
      "SELECT concept_graph_version FROM current_manifest",
    )
    .get();
  if (!row?.concept_graph_version) return [];
  return db
    .query<ConceptEdgeRow, [string]>("SELECT * FROM concept_edges WHERE graph_version = ?")
    .all(row.concept_graph_version);
}
