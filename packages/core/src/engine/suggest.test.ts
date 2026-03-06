import { test, expect } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { computeSuggestions } from "./suggest.ts";
import { insertConcept, insertConceptVersion } from "@/db/concepts.ts";
import { insertNarrative } from "@/db/narratives.ts";
import { upsertConceptRelation } from "@/db/concept-relations.ts";
import { insertEmbedding } from "@/db/embeddings.ts";
import { insertChunk } from "@/db/chunks.ts";

// Helper: create a narrative opened N days ago
function openNarrativeAgedDays(
  db: ReturnType<typeof createTestDb>,
  name: string,
  daysAgo: number,
  entryCount = 0,
) {
  const narrative = insertNarrative(db, name, "test intent");
  const openedAt = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString();
  db.run(`UPDATE narratives SET opened_at = ?, entry_count = ? WHERE id = ?`, [
    openedAt,
    entryCount,
    narrative.id,
  ]);
  return narrative;
}

test("close-narrative suggestion for dangling narrative with entries", async () => {
  const db = createTestDb();

  openNarrativeAgedDays(db, "explore-auth", 5, 8);

  const result = await computeSuggestions(db, "");

  expect(result.suggestions.length).toBeGreaterThan(0);
  const s = result.suggestions.find((s) => s.kind === "close-narrative");
  expect(s).toBeDefined();
  expect(s!.steps[0]!.tool).toBe("close");
  expect(s!.steps[0]!.args).toMatchObject({ narrative: "explore-auth" });
  expect(s!.confidence).toBe(1.0);
  expect(s!.priority).toBe(1);
  expect(s!.evidence.entry_count).toBe(8);

  db.close();
});

test("abandon-narrative suggestion for dangling narrative with no entries", async () => {
  const db = createTestDb();

  openNarrativeAgedDays(db, "empty-narrative", 4, 0);

  const result = await computeSuggestions(db, "");

  const s = result.suggestions.find((s) => s.kind === "abandon-narrative");
  expect(s).toBeDefined();
  expect(s!.steps[0]!.tool).toBe("open");
  expect(
    (s!.steps[0]!.args as { resolve_dangling?: { narrative: string; action: string } })
      .resolve_dangling?.narrative,
  ).toBe("empty-narrative");
  expect(
    (s!.steps[0]!.args as { resolve_dangling?: { narrative: string; action: string } })
      .resolve_dangling?.action,
  ).toBe("abandon");

  db.close();
});

test("clean-relation suggestion when relation target is archived", async () => {
  const db = createTestDb();

  const from = insertConcept(db, "auth-flow");
  const to = insertConcept(db, "redis-client");

  // Archive the target
  insertConceptVersion(db, to.id, {
    lifecycle_status: "archived",
    archived_at: new Date().toISOString(),
    lifecycle_reason: "deprecated",
  });

  upsertConceptRelation(db, from.id, to.id, "depends_on", 1.0);

  const result = await computeSuggestions(db, "");

  const s = result.suggestions.find((s) => s.kind === "clean-relation");
  expect(s).toBeDefined();
  expect(s!.steps[0]!.tool).toBe("relate");
  expect(
    (s!.steps[0]!.args as { from: string; to: string; type: string; remove: boolean }).from,
  ).toBe("auth-flow");
  expect(
    (s!.steps[0]!.args as { from: string; to: string; type: string; remove: boolean }).to,
  ).toBe("redis-client");
  expect(
    (s!.steps[0]!.args as { from: string; to: string; type: string; remove: boolean }).type,
  ).toBe("depends_on");
  expect(
    (s!.steps[0]!.args as { from: string; to: string; type: string; remove: boolean }).remove,
  ).toBe(true);
  expect(s!.evidence.target_lifecycle).toBe("archived");

  db.close();
});

test("merge suggestion for high-similarity concept pairs", async () => {
  const db = createTestDb();

  const a = insertConcept(db, "auth-flow");
  const b = insertConcept(db, "login-pipeline");

  const chunkIdA = "chunk-auth-flow-001";
  const chunkIdB = "chunk-login-pipeline-001";
  const now = new Date().toISOString();

  // Create chunks for embeddings
  insertChunk(db, {
    id: chunkIdA,
    filePath: ".lore/chunks/auth-flow.md",
    flType: "chunk",
    conceptId: a.id,
    createdAt: now,
  });
  insertChunk(db, {
    id: chunkIdB,
    filePath: ".lore/chunks/login-pipeline.md",
    flType: "chunk",
    conceptId: b.id,
    createdAt: now,
  });

  // Give b higher ground_residual so it's the source (higher ground_residual = source)
  insertConceptVersion(db, a.id, { ground_residual: 0.1, cluster: 1, active_chunk_id: chunkIdA });
  insertConceptVersion(db, b.id, { ground_residual: 0.9, cluster: 1, active_chunk_id: chunkIdB });

  // Insert very similar embeddings (nearly identical vectors → cosine sim ≈ 1.0)
  const vecA = new Float32Array(4).fill(0.5);
  const vecB = new Float32Array(4).fill(0.5);
  vecB[0] = 0.501; // tiny difference → very high similarity
  insertEmbedding(db, chunkIdA, vecA, "test-model");
  insertEmbedding(db, chunkIdB, vecB, "test-model");

  const result = await computeSuggestions(db, "");

  expect(result.meta.pairwise_computed).toBe(true);
  const s = result.suggestions.find((s) => s.kind === "merge");
  expect(s).toBeDefined();
  // source = higher residual (b=login-pipeline), into = lower residual (a=auth-flow)
  const mergeStep = s!.steps.find((st) => st.tool === "merge");
  expect(mergeStep).toBeDefined();
  expect((mergeStep!.args as { source: string; into: string }).source).toBe("login-pipeline");
  expect((mergeStep!.args as { source: string; into: string }).into).toBe("auth-flow");

  db.close();
});

test("archive suggestion for isolated high-staleness concept", async () => {
  const db = createTestDb();

  const concept = insertConcept(db, "legacy-uploader");
  insertConceptVersion(db, concept.id, { staleness: 0.9 });

  const result = await computeSuggestions(db, "");

  const s = result.suggestions.find((s) => s.kind === "archive");
  expect(s).toBeDefined();
  expect(s!.steps[0]!.tool).toBe("archive");
  expect((s!.steps[0]!.args as { concept: string }).concept).toBe("legacy-uploader");
  expect(s!.evidence.staleness).toBeGreaterThan(0.7);

  db.close();
});

test("review suggestion for high-residual concept", async () => {
  const db = createTestDb();

  const concept = insertConcept(db, "query-router");
  // ground_residual drives conceptPressureBase — must exceed REVIEW_RESIDUAL_THRESHOLD (0.65)
  insertConceptVersion(db, concept.id, { ground_residual: 0.8 });

  const result = await computeSuggestions(db, "");

  const s = result.suggestions.find((s) => s.kind === "review");
  expect(s).toBeDefined();
  const openStep = s!.steps.find((st) => st.tool === "open");
  expect(openStep).toBeDefined();
  expect((openStep!.args as { narrative: string }).narrative).toBe("review-query-router");
  const showStep = s!.steps.find((st) => st.tool === "show");
  expect(showStep).toBeDefined();
  expect((showStep!.args as { concept: string }).concept).toBe("query-router");

  db.close();
});

test("results are sorted by priority then confidence descending", async () => {
  const db = createTestDb();

  // Two dangling narratives (priority 1), one with more entries
  openNarrativeAgedDays(db, "narrative-a", 5, 3);
  openNarrativeAgedDays(db, "narrative-b", 6, 12);

  const result = await computeSuggestions(db, "");

  const p1 = result.suggestions.filter((s) => s.priority === 1);
  expect(p1.length).toBe(2);
  // All priority-1 items before any lower priority items
  for (let i = 0; i < result.suggestions.length - 1; i++) {
    expect(result.suggestions[i]!.priority).toBeLessThanOrEqual(
      result.suggestions[i + 1]!.priority,
    );
  }

  db.close();
});

test("limit option caps the number of suggestions", async () => {
  const db = createTestDb();

  // Create several signals
  openNarrativeAgedDays(db, "d1", 5, 1);
  openNarrativeAgedDays(db, "d2", 5, 1);
  openNarrativeAgedDays(db, "d3", 5, 1);

  const result = await computeSuggestions(db, "", { limit: 2 });
  expect(result.suggestions.length).toBeLessThanOrEqual(2);

  db.close();
});

test("meta fields are populated correctly", async () => {
  const db = createTestDb();

  insertConcept(db, "alpha");
  insertConcept(db, "beta");

  const result = await computeSuggestions(db, "");

  expect(result.meta.concept_count).toBe(2);
  expect(typeof result.meta.computed_at).toBe("string");
  expect(result.meta.pairwise_computed).toBe(true);

  db.close();
});
