import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import * as lancedb from "@lancedb/lancedb";
import {
  RECLAIM_MIN_SUPERSEDED_BYTES,
  compactLanceIndex,
  getLanceSpace,
  lanceDir,
  reclaimLanceSpace,
} from "./lance-index.ts";

/** 2000 rows of a 256-dimension vector, about 2 MB per version. */
function rows(seed: number) {
  return Array.from({ length: 2000 }, (_, i) => ({
    id: `id-${i}`,
    fl_type: "chunk",
    vector: Array.from({ length: 256 }, (_, k) => ((i + k + seed) % 97) / 97),
  }));
}

/** A store whose one table holds `generations` superseded versions. */
async function storeWithSupersededVersions(generations: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "lore-lance-"));
  const connection = await lancedb.connect(dir);
  const table = await connection.createTable("vec_test", rows(0));
  for (let generation = 1; generation <= generations; generation++) {
    // Every id already exists, so each merge rewrites the whole data file and
    // leaves the previous one on disk.
    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows(generation));
  }
  return dir;
}

test("lanceDir puts the store beside the database file", () => {
  expect(lanceDir("/tmp/mind")).toBe("/tmp/mind/lance");
});

test("getLanceSpace reports zero for a store that does not exist", async () => {
  const space = await getLanceSpace(join(tmpdir(), "lore-lance-absent"));

  expect(space.on_disk_bytes).toBe(0);
  expect(space.live_bytes).toBe(0);
  expect(space.superseded_bytes).toBe(0);
  expect(space.superseded_ratio).toBe(0);
});

test("getLanceSpace separates the live version from the superseded ones", async () => {
  const dir = await storeWithSupersededVersions(3);

  const space = await getLanceSpace(dir);

  expect(space.on_disk_bytes).toBeGreaterThan(space.live_bytes);
  expect(space.superseded_bytes).toBeGreaterThan(0);
  expect(space.superseded_ratio).toBeGreaterThan(0.5);
  expect(space.live_bytes + space.superseded_bytes).toBe(space.on_disk_bytes);

  rmSync(dir, { recursive: true, force: true });
});

test("compactLanceIndex returns the superseded versions to the filesystem", async () => {
  const dir = await storeWithSupersededVersions(3);
  const before = await getLanceSpace(dir);

  // retainMs 0: every version but the current one is old enough to remove.
  const result = await compactLanceIndex(dir, { retainMs: 0 });
  const after = await getLanceSpace(dir);

  expect(result.tables).toBe(1);
  expect(result.reclaimed_bytes).toBeGreaterThan(0);
  expect(result.bytes_before).toBe(before.on_disk_bytes);
  expect(result.bytes_after).toBe(after.on_disk_bytes);
  expect(after.on_disk_bytes).toBeLessThan(before.on_disk_bytes);
  expect(after.superseded_bytes).toBeLessThan(before.superseded_bytes);

  rmSync(dir, { recursive: true, force: true });
});

test("compactLanceIndex keeps the rows the live version holds", async () => {
  const dir = await storeWithSupersededVersions(3);

  await compactLanceIndex(dir, { retainMs: 0 });

  const connection = await lancedb.connect(dir);
  const table = await connection.openTable("vec_test");
  expect(await table.countRows()).toBe(2000);

  rmSync(dir, { recursive: true, force: true });
});

test("compactLanceIndex keeps the versions inside the retention window", async () => {
  const dir = await storeWithSupersededVersions(3);
  const before = await getLanceSpace(dir);

  // Every version was written seconds ago, so an hour of retention holds them all.
  const result = await compactLanceIndex(dir, { retainMs: 60 * 60_000 });

  expect(result.reclaimed_bytes).toBe(0);
  expect((await getLanceSpace(dir)).superseded_bytes).toBe(before.superseded_bytes);

  rmSync(dir, { recursive: true, force: true });
});

test("compactLanceIndex accepts a store that does not exist", async () => {
  const result = await compactLanceIndex(join(tmpdir(), "lore-lance-absent"));

  expect(result).toEqual({
    tables: 0,
    bytes_before: 0,
    bytes_after: 0,
    reclaimed_bytes: 0,
  });
});

test("reclaimLanceSpace leaves a store below the size limit alone", async () => {
  const dir = await storeWithSupersededVersions(3);
  const before = await getLanceSpace(dir);
  // The fixture is megabytes, and the limit is tens of megabytes.
  expect(before.superseded_bytes).toBeLessThan(RECLAIM_MIN_SUPERSEDED_BYTES);

  expect(await reclaimLanceSpace(dir)).toBeNull();
  expect((await getLanceSpace(dir)).superseded_bytes).toBe(before.superseded_bytes);

  rmSync(dir, { recursive: true, force: true });
});
