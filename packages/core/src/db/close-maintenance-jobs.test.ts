import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  queueCloseMaintenanceJob,
  claimCloseMaintenanceJob,
  completeCloseMaintenanceJob,
  failCloseMaintenanceJob,
  getCloseMaintenanceJobCounts,
} from "./close-maintenance-jobs.ts";

test("queue, claim, and complete close maintenance jobs", () => {
  const db = createTestDb();
  const queued = queueCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-1",
    narrativeName: "perf-work",
    commitId: "commit-1",
    payload: { touched: ["auth-model"] },
  });

  const claimed = claimCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-1",
  });
  expect(claimed?.id).toBe(queued.id);
  expect(claimed?.status).toBe("leased");

  expect(
    completeCloseMaintenanceJob(db, {
      lorePath: "/tmp/lore",
      id: queued.id,
      owner: "worker-1",
    }),
  ).toBe(true);

  const counts = getCloseMaintenanceJobCounts(db, { lorePath: "/tmp/lore" });
  expect(counts.done).toBe(1);
  expect(counts.queued).toBe(0);
  expect(counts.leased).toBe(0);

  db.close();
});

test("failed close maintenance jobs requeue until retries are exhausted", () => {
  const db = createTestDb();
  const queued = queueCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    narrativeId: "n-2",
    narrativeName: "perf-work",
    commitId: "commit-2",
    payload: { touched: ["cache-layer"] },
  });

  const firstLease = claimCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-1",
    maxRetries: 1,
  });
  expect(firstLease?.id).toBe(queued.id);
  const firstFailure = failCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    id: queued.id,
    owner: "worker-1",
    error: "temporary failure",
    retry: true,
    maxRetries: 1,
  });
  expect(firstFailure.requeued).toBe(true);
  expect(firstFailure.status).toBe("queued");

  const secondLease = claimCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    owner: "worker-2",
    maxRetries: 1,
  });
  expect(secondLease?.id).toBe(queued.id);
  const secondFailure = failCloseMaintenanceJob(db, {
    lorePath: "/tmp/lore",
    id: queued.id,
    owner: "worker-2",
    error: "permanent failure",
    retry: true,
    maxRetries: 1,
  });
  expect(secondFailure.requeued).toBe(false);
  expect(secondFailure.status).toBe("failed");

  const counts = getCloseMaintenanceJobCounts(db, { lorePath: "/tmp/lore" });
  expect(counts.failed).toBe(1);
  expect(counts.queued).toBe(0);

  db.close();
});
