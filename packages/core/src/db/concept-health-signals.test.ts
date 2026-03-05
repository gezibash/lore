import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import { insertConcept } from "./concepts.ts";
import {
  insertConceptHealthSignal,
  getCurrentConceptHealthSignal,
  getLatestConceptHealthRun,
  getTopCurrentConceptHealthRows,
  getConceptHealthExplainRow,
} from "./concept-health-signals.ts";

test("current_concept_health_signals keeps latest row per concept", () => {
  const db = createTestDb();
  const concept = insertConcept(db, "alpha");

  insertConceptHealthSignal(
    db,
    {
      run_id: "run-1",
      concept_id: concept.id,
      time_stale: 0.1,
      ref_stale: 0,
      local_graph_stale: 0,
      global_shock: 0,
      influence: 0,
      critical_multiplier: 1,
      final_stale: 0.1,
      residual_after_adjust: 0.1,
      debt_after_adjust: 0.1,
    },
    "2026-02-24T00:00:00.000Z",
  );
  insertConceptHealthSignal(
    db,
    {
      run_id: "run-2",
      concept_id: concept.id,
      time_stale: 0.4,
      ref_stale: 0.2,
      local_graph_stale: 0.2,
      global_shock: 0.1,
      influence: 0.1,
      critical_multiplier: 1.2,
      final_stale: 0.6,
      residual_after_adjust: 0.5,
      debt_after_adjust: 0.3,
    },
    "2026-02-24T01:00:00.000Z",
  );

  const current = getCurrentConceptHealthSignal(db, concept.id);
  expect(current?.run_id).toBe("run-2");
  expect(current?.final_stale).toBe(0.6);

  const latestRun = getLatestConceptHealthRun(db);
  expect(latestRun?.run_id).toBe("run-2");

  db.close();
});

test("getTopCurrentConceptHealthRows returns concept names and critical flag", () => {
  const db = createTestDb();
  const a = insertConcept(db, "alpha");
  const b = insertConcept(db, "beta");

  insertConceptHealthSignal(db, {
    run_id: "run-1",
    concept_id: a.id,
    time_stale: 0.3,
    ref_stale: 0,
    local_graph_stale: 0,
    global_shock: 0,
    influence: 0,
    critical_multiplier: 1,
    final_stale: 0.3,
    residual_after_adjust: 0.3,
    debt_after_adjust: 0.2,
  });

  insertConceptHealthSignal(db, {
    run_id: "run-1",
    concept_id: b.id,
    time_stale: 0.4,
    ref_stale: 0,
    local_graph_stale: 0,
    global_shock: 0,
    influence: 0,
    critical_multiplier: 1.4,
    final_stale: 0.7,
    residual_after_adjust: 0.6,
    debt_after_adjust: 0.2,
  });

  const top = getTopCurrentConceptHealthRows(db, 5);
  expect(top[0]?.concept).toBe("beta");
  expect(top[0]?.critical).toBe(true);

  const explain = getConceptHealthExplainRow(db, b.id);
  expect(explain?.concept).toBe("beta");
  expect(explain?.signal.critical).toBe(true);

  db.close();
});
