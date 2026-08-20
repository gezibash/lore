import { test, expect } from "bun:test";
import type { Database } from "bun:sqlite";
import type { ConceptRow } from "@/types/index.ts";
import { createTestDb } from "../../test/support/db.ts";
import {
  computeExpectedDebt,
  computeStateDistanceSpec,
  getConceptBindingStats,
  groundednessResidual,
} from "./measurement.ts";

function concept(id: string, groundResidual: number | null): ConceptRow {
  return {
    id,
    name: id,
    version_id: `v-${id}`,
    residual: null,
    churn: null,
    ground_residual: groundResidual,
    lore_residual: null,
    active_chunk_id: null,
    staleness: null,
    cluster: null,
    is_hub: null,
    lifecycle_status: "active",
    archived_at: null,
    lifecycle_reason: null,
    merged_into_concept_id: null,
    inserted_at: new Date().toISOString(),
  } as ConceptRow;
}

function seedSymbol(db: Database, id: string, bodyHash: string): void {
  db.run(
    `INSERT OR IGNORE INTO source_files (id, file_path, language, content_hash, size_bytes, symbol_count, scanned_at)
     VALUES ('sf-1', 'src/a.ts', 'typescript', 'h', 1, 0, '2026-01-01')`,
  );
  db.run(
    `INSERT INTO symbols (id, source_file_id, name, qualified_name, kind, line_start, line_end, body_hash, scanned_at)
     VALUES (?, 'sf-1', ?, ?, 'function', 1, 2, ?, '2026-01-01')`,
    [id, id, id, bodyHash],
  );
}

function bind(db: Database, conceptId: string, symbolId: string, boundHash: string): void {
  db.run(
    `INSERT INTO concept_symbols (id, concept_id, symbol_id, binding_type, confidence, bound_body_hash, created_at, updated_at)
     VALUES (?, ?, ?, 'ref', 1.0, ?, '2026-01-01', '2026-01-01')`,
    [`cs-${conceptId}-${symbolId}`, conceptId, symbolId, boundHash],
  );
}

test("debt equals mean R with zero interaction events (uniform prior)", () => {
  const db = createTestDb();
  seedSymbol(db, "sym-a", "hash-1");
  bind(db, "a", "sym-a", "hash-1"); // bound, undrifted → R = e_embed = 0.4

  const concepts = [concept("a", 0.4), concept("b", 0.2)]; // b is ungrounded → R = 1
  const result = computeExpectedDebt(db, concepts);
  expect(result.debt).toBeCloseTo((0.4 + 1.0) / 2);
  expect(result.ungroundedCount).toBe(1);
  db.close();
});

test("creating a new healthy grounded concept never increases debt", () => {
  const db = createTestDb();
  seedSymbol(db, "sym-a", "hash-1");
  seedSymbol(db, "sym-c", "hash-2");
  bind(db, "a", "sym-a", "hash-1");

  const before = computeExpectedDebt(db, [concept("a", 0.6)]).debt!;
  bind(db, "c", "sym-c", "hash-2"); // healthy: bound, undrifted, residual 0
  const after = computeExpectedDebt(db, [concept("a", 0.6), concept("c", 0)]).debt!;
  expect(after).toBeLessThanOrEqual(before);
  db.close();
});

test("a concept-less mind reports null debt, not zero", () => {
  const db = createTestDb();
  expect(computeExpectedDebt(db, []).debt).toBeNull();
  db.close();
});

test("e_drift is a ratio, not a count step", () => {
  const db = createTestDb();
  for (let i = 0; i < 4; i++) seedSymbol(db, `sym-${i}`, `current-${i}`);
  bind(db, "a", "sym-0", "current-0"); // fresh
  bind(db, "a", "sym-1", "current-1"); // fresh
  bind(db, "a", "sym-2", "stale"); // drifted
  bind(db, "a", "sym-3", "stale"); // drifted

  const stats = getConceptBindingStats(db).get("a")!;
  expect(stats.total).toBe(4);
  expect(stats.drifted).toBe(2);
  const g = groundednessResidual(concept("a", 0.1), stats);
  expect(g.eDrift).toBeCloseTo(0.5); // 2 of 4 — not the old count-step 0.7
  expect(g.residual).toBeCloseTo(0.5); // max(e_drift, e_embed)
  db.close();
});

test("consulted concepts dominate debt", () => {
  const db = createTestDb();
  seedSymbol(db, "sym-a", "h1");
  seedSymbol(db, "sym-b", "h2");
  bind(db, "hot-wrong", "sym-a", "h1");
  bind(db, "cold-clean", "sym-b", "h2");

  for (let i = 0; i < 20; i++) {
    db.run(
      `INSERT INTO interaction_events (id, result_id, event_type, subject, meta_json, created_at)
       VALUES (?, NULL, 'show', 'hot-wrong', NULL, ?)`,
      [`ev-${i}`, new Date().toISOString()],
    );
  }
  const concepts = [concept("hot-wrong", 0.9), concept("cold-clean", 0.0)];
  const uniform = (0.9 + 0.0) / 2;
  const weighted = computeExpectedDebt(db, concepts).debt!;
  expect(weighted).toBeGreaterThan(uniform); // the consulted, wrong concept dominates
  db.close();
});

test("state distance: adding an unbound concept increases D; binding it decreases D", () => {
  const db = createTestDb();
  seedSymbol(db, "sym-a", "h1");
  seedSymbol(db, "sym-b", "h2");
  bind(db, "a", "sym-a", "h1");

  const base = computeStateDistanceSpec(db, [concept("a", 0.2)]);
  const withUnbound = computeStateDistanceSpec(db, [concept("a", 0.2), concept("u", null)]);
  expect(withUnbound).toBeGreaterThan(base);

  bind(db, "u", "sym-b", "h2"); // grounding the claim
  const afterBinding = computeStateDistanceSpec(db, [concept("a", 0.2), concept("u", 0.1)]);
  expect(afterBinding).toBeLessThan(withUnbound);
  db.close();
});
