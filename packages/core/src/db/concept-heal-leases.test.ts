import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  claimConceptHealLease,
  completeConceptHealLease,
  failConceptHealLease,
  getConceptHealLease,
  getConceptHealLeaseStatusCounts,
  queueConceptHealLeases,
} from "./concept-heal-leases.ts";

const LORE_PATH = "/tmp/.lore/test";
const RUN_ID = "heal-run-1";

test("queue, claim, and complete concept heal lease", () => {
  const db = createTestDb();

  const inserted = queueConceptHealLeases(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptIds: ["auth-model"],
    now: "2026-02-24T00:00:00.000Z",
  });
  expect(inserted).toBe(1);

  const lease = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-1",
    leaseTtlMs: 10_000,
    maxRetries: 1,
    now: "2026-02-24T00:00:01.000Z",
  });

  expect(lease?.concept_id).toBe("auth-model");
  expect(lease?.status).toBe("leased");
  expect(lease?.attempt).toBe(1);

  const completed = completeConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptId: "auth-model",
    owner: "worker-1",
    now: "2026-02-24T00:00:02.000Z",
  });
  expect(completed).toBe(true);

  const row = getConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptId: "auth-model",
  });
  expect(row?.status).toBe("done");
  expect(row?.attempt).toBe(1);

  db.close();
});

test("failed lease requeues until retries are exhausted", () => {
  const db = createTestDb();

  queueConceptHealLeases(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptIds: ["cache-layer"],
    now: "2026-02-24T01:00:00.000Z",
  });

  const first = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-1",
    maxRetries: 1,
    now: "2026-02-24T01:00:01.000Z",
  });
  expect(first?.attempt).toBe(1);

  const failedFirst = failConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptId: "cache-layer",
    owner: "worker-1",
    error: "transient",
    retry: true,
    maxRetries: 1,
    now: "2026-02-24T01:00:02.000Z",
  });
  expect(failedFirst.requeued).toBe(true);
  expect(failedFirst.status).toBe("queued");

  const second = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-2",
    maxRetries: 1,
    now: "2026-02-24T01:00:03.000Z",
  });
  expect(second?.attempt).toBe(2);

  const failedSecond = failConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptId: "cache-layer",
    owner: "worker-2",
    error: "still failing",
    retry: true,
    maxRetries: 1,
    now: "2026-02-24T01:00:04.000Z",
  });
  expect(failedSecond.requeued).toBe(false);
  expect(failedSecond.status).toBe("failed");

  const third = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-3",
    maxRetries: 1,
    now: "2026-02-24T01:00:05.000Z",
  });
  expect(third).toBeNull();

  db.close();
});

test("expired lease can be reclaimed and counts are reported", () => {
  const db = createTestDb();

  queueConceptHealLeases(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    conceptIds: ["query-router"],
    now: "2026-02-24T02:00:00.000Z",
  });

  const first = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-1",
    leaseTtlMs: 1_000,
    maxRetries: 2,
    now: "2026-02-24T02:00:01.000Z",
  });
  expect(first?.attempt).toBe(1);

  const beforeExpiry = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-2",
    leaseTtlMs: 1_000,
    maxRetries: 2,
    now: "2026-02-24T02:00:01.500Z",
  });
  expect(beforeExpiry).toBeNull();

  const afterExpiry = claimConceptHealLease(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
    owner: "worker-2",
    leaseTtlMs: 1_000,
    maxRetries: 2,
    now: "2026-02-24T02:00:03.000Z",
  });
  expect(afterExpiry?.attempt).toBe(2);

  const counts = getConceptHealLeaseStatusCounts(db, {
    lorePath: LORE_PATH,
    runId: RUN_ID,
  });
  expect(counts.total).toBe(1);
  expect(counts.leased).toBe(1);
  expect(counts.queued).toBe(0);

  db.close();
});
