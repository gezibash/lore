import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ConceptRelationRow, RelationType } from "@/types/index.ts";

export function upsertConceptRelation(
  db: Database,
  fromConceptId: string,
  toConceptId: string,
  relationType: RelationType,
  weight: number,
): ConceptRelationRow {
  const normalizedWeight = Number.isFinite(weight) ? Math.max(0, Math.min(weight, 1)) : 1;
  const now = new Date().toISOString();

  const existing = db
    .query<ConceptRelationRow, [string, string, string]>(
      `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
       FROM concept_relations
       WHERE from_concept_id = ? AND to_concept_id = ? AND relation_type = ?
       ORDER BY rowid DESC
       LIMIT 1`,
    )
    .get(fromConceptId, toConceptId, relationType);

  if (existing) {
    db.query(
      `UPDATE concept_relations SET weight = ?, active = 1, updated_at = ? WHERE id = ?`,
    ).run(normalizedWeight, now, existing.id);
    return {
      ...existing,
      weight: normalizedWeight,
      active: 1,
      updated_at: now,
    };
  }

  const row: ConceptRelationRow = {
    id: ulid(),
    from_concept_id: fromConceptId,
    to_concept_id: toConceptId,
    relation_type: relationType,
    weight: normalizedWeight,
    active: 1,
    created_at: now,
    updated_at: now,
  };

  db.query(
    `INSERT INTO concept_relations
       (id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.from_concept_id,
    row.to_concept_id,
    row.relation_type,
    row.weight,
    row.active,
    row.created_at,
    row.updated_at,
  );

  return row;
}

export function deactivateConceptRelation(
  db: Database,
  fromConceptId: string,
  toConceptId: string,
  relationType?: RelationType,
): number {
  const now = new Date().toISOString();
  if (relationType) {
    const result = db
      .query(
        `UPDATE concept_relations
         SET active = 0, updated_at = ?
         WHERE from_concept_id = ? AND to_concept_id = ? AND relation_type = ? AND active = 1`,
      )
      .run(now, fromConceptId, toConceptId, relationType);
    return Number(result.changes ?? 0);
  }

  const result = db
    .query(
      `UPDATE concept_relations
       SET active = 0, updated_at = ?
       WHERE from_concept_id = ? AND to_concept_id = ? AND active = 1`,
    )
    .run(now, fromConceptId, toConceptId);
  return Number(result.changes ?? 0);
}

export function getConceptRelations(
  db: Database,
  opts?: {
    conceptId?: string;
    includeInactive?: boolean;
  },
): ConceptRelationRow[] {
  const includeInactive = opts?.includeInactive ?? false;

  if (!opts?.conceptId) {
    if (includeInactive) {
      return db
        .query<ConceptRelationRow, []>(
          `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
           FROM concept_relations
           ORDER BY updated_at DESC, created_at DESC`,
        )
        .all();
    }

    return db
      .query<ConceptRelationRow, []>(
        `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
         FROM concept_relations
         WHERE active = 1
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all();
  }

  if (includeInactive) {
    return db
      .query<ConceptRelationRow, [string, string]>(
        `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
         FROM concept_relations
         WHERE from_concept_id = ? OR to_concept_id = ?
         ORDER BY updated_at DESC, created_at DESC`,
      )
      .all(opts.conceptId, opts.conceptId);
  }

  return db
    .query<ConceptRelationRow, [string, string]>(
      `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
       FROM concept_relations
       WHERE active = 1 AND (from_concept_id = ? OR to_concept_id = ?)
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(opts.conceptId, opts.conceptId);
}

export function getActiveRelationNeighbors(db: Database, conceptId: string): ConceptRelationRow[] {
  return db
    .query<ConceptRelationRow, [string, string]>(
      `SELECT id, from_concept_id, to_concept_id, relation_type, weight, active, created_at, updated_at
       FROM concept_relations
       WHERE active = 1 AND (from_concept_id = ? OR to_concept_id = ?)
       ORDER BY updated_at DESC, created_at DESC`,
    )
    .all(conceptId, conceptId);
}

export function get2HopNeighbors(
  db: Database,
  conceptId: string,
): Array<{ conceptId: string; via: string; weight: number }> {
  const hop1 = getActiveRelationNeighbors(db, conceptId);
  const hop1Map = new Map<string, number>();
  for (const rel of hop1) {
    const otherId = rel.from_concept_id === conceptId ? rel.to_concept_id : rel.from_concept_id;
    const existing = hop1Map.get(otherId);
    if (existing == null || rel.weight > existing) {
      hop1Map.set(otherId, rel.weight);
    }
  }

  const seen = new Set<string>([conceptId, ...hop1Map.keys()]);
  const results: Array<{ conceptId: string; via: string; weight: number }> = [];
  for (const [viaId, hop1Weight] of hop1Map) {
    const hop2 = getActiveRelationNeighbors(db, viaId);
    for (const rel of hop2) {
      const targetId = rel.from_concept_id === viaId ? rel.to_concept_id : rel.from_concept_id;
      if (!seen.has(targetId)) {
        seen.add(targetId);
        results.push({ conceptId: targetId, via: viaId, weight: hop1Weight * rel.weight });
      }
    }
  }
  return results;
}
