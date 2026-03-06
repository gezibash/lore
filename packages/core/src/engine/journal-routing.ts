import type { Database } from "bun:sqlite";
import { getConcept, getActiveConceptByName } from "@/db/index.ts";
import {
  LoreError,
  type ChunkRow,
  type NarrativeRow,
  type NarrativeTarget,
} from "@/types/index.ts";

function normalizeConceptNames(names: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of names ?? []) {
    const name = raw.trim();
    if (!name) continue;
    if (seen.has(name)) continue;
    seen.add(name);
    normalized.push(name);
  }
  return normalized;
}

export function getCreateUpdateTargets(
  narrative: NarrativeRow,
): Array<{ op: "create" | "update"; concept: string }> {
  if (!narrative.targets) return [];
  return (JSON.parse(narrative.targets) as NarrativeTarget[]).filter(
    (target): target is { op: "create" | "update"; concept: string } =>
      target.op === "create" || target.op === "update",
  );
}

export function inferDefaultJournalConceptDesignations(narrative: NarrativeRow): string[] | null {
  const targets = getCreateUpdateTargets(narrative);
  if (targets.length !== 1) return null;
  return [targets[0]!.concept];
}

export function resolveJournalConceptDesignations(
  db: Database,
  narrative: NarrativeRow,
  requestedConcepts?: readonly string[],
): { designations: string[]; conceptRefs: string[]; autoInherited: boolean } {
  const explicit = normalizeConceptNames(requestedConcepts);
  const inherited =
    explicit.length === 0 ? inferDefaultJournalConceptDesignations(narrative) : null;
  const designations = explicit.length > 0 ? explicit : (inherited ?? []);
  if (designations.length === 0) {
    throw new LoreError(
      "JOURNAL_CONCEPTS_REQUIRED",
      `Journal entry for narrative '${narrative.name}' needs explicit concepts. Pass --concept or open the narrative with exactly one create/update target.`,
    );
  }

  const declaredTargets = getCreateUpdateTargets(narrative);
  const declaredTargetNames = new Set(declaredTargets.map((target) => target.concept));
  const resolvedConceptIds: string[] = [];

  for (const conceptName of designations) {
    if (declaredTargetNames.size > 0 && !declaredTargetNames.has(conceptName)) {
      throw new LoreError(
        "JOURNAL_CONCEPT_OUTSIDE_TARGETS",
        `Journal concept '${conceptName}' is outside the declared narrative targets for '${narrative.name}'.`,
      );
    }

    const activeConcept = getActiveConceptByName(db, conceptName);
    if (activeConcept) {
      resolvedConceptIds.push(activeConcept.id);
      continue;
    }

    const declaredCreateTarget = declaredTargets.find(
      (target) => target.op === "create" && target.concept === conceptName,
    );
    if (!declaredCreateTarget) {
      throw new LoreError(
        "CONCEPT_NOT_FOUND",
        `Journal concept '${conceptName}' does not exist and is not declared as a create target for '${narrative.name}'.`,
      );
    }
  }

  return {
    designations,
    conceptRefs: resolvedConceptIds,
    autoInherited: explicit.length === 0 && inherited != null,
  };
}

export function loadJournalConceptDesignations(
  db: Database,
  chunk: Pick<ChunkRow, "concept_designations" | "concept_refs">,
): string[] {
  if (chunk.concept_designations) {
    try {
      return normalizeConceptNames(JSON.parse(chunk.concept_designations) as string[]);
    } catch {
      return [];
    }
  }

  if (!chunk.concept_refs) return [];
  try {
    const names = (JSON.parse(chunk.concept_refs) as string[])
      .map((conceptId) => getConcept(db, conceptId)?.name ?? null)
      .filter((name): name is string => !!name);
    return normalizeConceptNames(names);
  } catch {
    return [];
  }
}
