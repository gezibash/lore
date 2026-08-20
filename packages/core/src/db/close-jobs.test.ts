import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  claimCloseJob,
  completeCloseJob,
  failCloseJob,
  getCloseJob,
  getCloseJobCounts,
  getLatestPendingCloseJobForNarrative,
  queueCloseJob,
} from "./close-jobs.ts";

test("queue, claim, and complete close jobs", () => {
  const db = createTestDb();
  const queued = queueCloseJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-1",
    narrativeName: "auth-fix",
    payload: { mergeStrategy: "patch" },
  });

  const pending = getLatestPendingCloseJobForNarrative(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-1",
  });
  expect(pending?.id).toBe(queued.id);

  const claimed = claimCloseJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-1",
  });
  expect(claimed?.id).toBe(queued.id);
  expect(claimed?.status).toBe("leased");

  expect(
    completeCloseJob(db, {
      lorePath: "/tmp/lore",
      id: queued.id,
      owner: "worker-1",
      result: { integrated: true, commit_id: "c-1" },
    }),
  ).toBe(true);

  const stored = getCloseJob(db, { lorePath: "/tmp/lore", id: queued.id });
  expect(stored?.status).toBe("done");
  expect(stored?.close_result_json).toContain('"commit_id":"c-1"');

  const counts = getCloseJobCounts(db, { lorePath: "/tmp/lore" });
  expect(counts.done).toBe(1);
  expect(counts.queued).toBe(0);

  db.close();
});

test("failed close jobs requeue until retries are exhausted", () => {
  const db = createTestDb();
  const queued = queueCloseJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-2",
    narrativeName: "perf-fix",
    payload: { mergeStrategy: "patch" },
  });

  const firstLease = claimCloseJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-1",
    maxRetries: 1,
  });
  expect(firstLease?.id).toBe(queued.id);

  const firstFailure = failCloseJob(db, {
    lorePath: "/tmp/lore",
    id: queued.id,
    owner: "worker-1",
    error: "temporary failure",
    retry: true,
    maxRetries: 1,
  });
  expect(firstFailure.requeued).toBe(true);
  expect(firstFailure.status).toBe("queued");

  const secondLease = claimCloseJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-2",
    maxRetries: 1,
  });
  expect(secondLease?.id).toBe(queued.id);

  const secondFailure = failCloseJob(db, {
    lorePath: "/tmp/lore",
    id: queued.id,
    owner: "worker-2",
    error: "permanent failure",
    retry: true,
    maxRetries: 1,
  });
  expect(secondFailure.requeued).toBe(false);
  expect(secondFailure.status).toBe("failed");

  const counts = getCloseJobCounts(db, { lorePath: "/tmp/lore" });
  expect(counts.failed).toBe(1);
  expect(counts.queued).toBe(0);

  db.close();
});

test("N4: concurrent closes for one mind serialize on the lease", () => {
  const db = createTestDb();
  const first = queueCloseJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-1",
    narrativeName: "auth-fix",
    payload: {},
  });
  const second = queueCloseJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-2",
    narrativeName: "billing-fix",
    payload: {},
  });

  // ULIDs minted in the same millisecond are not queue-ordered; either job may
  // be claimed first. The invariant under test is exclusivity, not order.
  const claimed = claimCloseJob(db, { lorePath: "/tmp/lore", owner: "worker-1" });
  if (!claimed) throw new Error("first claim returned null");
  expect([first.id, second.id]).toContain(claimed.id);
  const unclaimed = claimed.id === first.id ? second : first;

  // Second claim must return null while the first lease is unexpired — even
  // for a different narrative, and even when addressed by id.
  expect(claimCloseJob(db, { lorePath: "/tmp/lore", owner: "worker-2" })).toBeNull();
  expect(
    claimCloseJob(db, { lorePath: "/tmp/lore", owner: "worker-2", id: unclaimed.id }),
  ).toBeNull();

  // A different mind is unaffected.
  const other = queueCloseJob(db, {
    lorePath: "/tmp/other",
    narrativeId: "n-9",
    narrativeName: "other",
    payload: {},
  });
  expect(claimCloseJob(db, { lorePath: "/tmp/other", owner: "worker-2" })?.id).toBe(other.id);

  // Completing the first lease frees the mind.
  completeCloseJob(db, { lorePath: "/tmp/lore", id: claimed!.id, owner: "worker-1", result: {} });
  expect(claimCloseJob(db, { lorePath: "/tmp/lore", owner: "worker-2" })?.id).toBe(unclaimed.id);

  db.close();
});

test("N4: an expired lease does not block the next claim", () => {
  const db = createTestDb();
  queueCloseJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-1",
    narrativeName: "auth-fix",
    payload: {},
  });
  const t0 = "2026-08-20T10:00:00.000Z";
  const claimed = claimCloseJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-1",
    leaseTtlMs: 1000,
    now: t0,
  });
  expect(claimed).not.toBeNull();

  // Lease expired: the same job is reclaimable (crash recovery unchanged).
  // maxRetries must allow a second attempt — the default of 0 permits only one.
  const later = "2026-08-20T10:00:02.000Z";
  const reclaimed = claimCloseJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-2",
    maxRetries: 2,
    now: later,
  });
  expect(reclaimed?.id).toBe(claimed!.id);
  expect(reclaimed?.owner).toBe("worker-2");

  db.close();
});
