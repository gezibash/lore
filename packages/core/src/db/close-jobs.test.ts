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
