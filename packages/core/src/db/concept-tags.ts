import type { Database } from "bun:sqlite";
import { ulid } from "ulid";
import type { ConceptTagRow } from "@/types/index.ts";

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

export function upsertConceptTag(db: Database, conceptId: string, tag: string): ConceptTagRow {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) {
    throw new Error("Tag cannot be empty");
  }

  const now = new Date().toISOString();
  const existing = db
    .query<ConceptTagRow, [string, string]>(
      `SELECT id, concept_id, tag, created_at
       FROM concept_tags
       WHERE concept_id = ? AND tag = ?
       LIMIT 1`,
    )
    .get(conceptId, normalizedTag);

  if (existing) {
    return existing;
  }

  const row: ConceptTagRow = {
    id: ulid(),
    concept_id: conceptId,
    tag: normalizedTag,
    created_at: now,
  };

  db.query(`INSERT INTO concept_tags (id, concept_id, tag, created_at) VALUES (?, ?, ?, ?)`).run(
    row.id,
    row.concept_id,
    row.tag,
    row.created_at,
  );

  return row;
}

export function removeConceptTag(db: Database, conceptId: string, tag: string): number {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) return 0;

  const result = db
    .query(`DELETE FROM concept_tags WHERE concept_id = ? AND tag = ?`)
    .run(conceptId, normalizedTag);
  return Number(result.changes ?? 0);
}

export function getConceptTags(db: Database, conceptId?: string): ConceptTagRow[] {
  if (!conceptId) {
    return db
      .query<ConceptTagRow, []>(
        `SELECT id, concept_id, tag, created_at
         FROM concept_tags
         ORDER BY concept_id ASC, tag ASC`,
      )
      .all();
  }

  return db
    .query<ConceptTagRow, [string]>(
      `SELECT id, concept_id, tag, created_at
       FROM concept_tags
       WHERE concept_id = ?
       ORDER BY tag ASC`,
    )
    .all(conceptId);
}

export function hasConceptTag(db: Database, conceptId: string, tag: string): boolean {
  const normalizedTag = normalizeTag(tag);
  if (!normalizedTag) return false;

  const row = db
    .query<{ found: number }, [string, string]>(
      `SELECT 1 as found
       FROM concept_tags
       WHERE concept_id = ? AND tag = ?
       LIMIT 1`,
    )
    .get(conceptId, normalizedTag);

  return (row?.found ?? 0) === 1;
}
