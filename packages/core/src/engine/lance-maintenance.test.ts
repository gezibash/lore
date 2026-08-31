import { expect, test } from "bun:test";
import * as lancedb from "@lancedb/lancedb";
import { LoreEngine } from "./index.ts";
import { getLanceSpace, lanceDir } from "./lance-index.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";

/** Register a mind whose Lance store holds three superseded versions. */
async function mindWithSupersededIndex(name: string): Promise<{
  engine: LoreEngine;
  codePath: string;
  loreRoot: string;
  lancePath: string;
}> {
  const loreRoot = createTempDir("lore-root-");
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });
  const registered = await engine.register(codePath, name);

  const lancePath = lanceDir(registered.lore_path);
  const connection = await lancedb.connect(lancePath);
  const rows = (seed: number) =>
    Array.from({ length: 500 }, (_, i) => ({
      id: `id-${i}`,
      fl_type: "chunk",
      vector: Array.from({ length: 128 }, (_, k) => ((i + k + seed) % 97) / 97),
    }));
  const table = await connection.createTable("vec_test", rows(0));
  for (let generation = 1; generation <= 3; generation++) {
    await table
      .mergeInsert("id")
      .whenMatchedUpdateAll()
      .whenNotMatchedInsertAll()
      .execute(rows(generation));
  }

  return { engine, codePath, loreRoot, lancePath };
}

test("pruneOrphans reports the search index beside the database", async () => {
  const { engine, codePath, loreRoot, lancePath } =
    await mindWithSupersededIndex("prune-lance-report");
  const space = await getLanceSpace(lancePath);
  expect(space.superseded_bytes).toBeGreaterThan(0);

  const result = await engine.pruneOrphans({ codePath });

  expect(result.mode).toBe("apply");
  expect(result.lance_bytes_before).toBe(space.on_disk_bytes);
  // Every version was written seconds ago, so the retention window holds them.
  expect(result.lance_bytes_after).toBe(space.on_disk_bytes);
  expect(result.lance_superseded_bytes).toBe(space.superseded_bytes);

  removeDir(loreRoot);
  removeDir(codePath);
});

test("pruneOrphans --check measures the search index without compacting it", async () => {
  const { engine, codePath, loreRoot, lancePath } =
    await mindWithSupersededIndex("prune-lance-check");
  const space = await getLanceSpace(lancePath);

  const result = await engine.pruneOrphans({ codePath, check: true });

  expect(result.mode).toBe("check");
  expect(result.lance_bytes_before).toBe(space.on_disk_bytes);
  expect(result.lance_bytes_after).toBe(space.on_disk_bytes);
  expect(result.lance_superseded_bytes).toBe(space.superseded_bytes);
  expect((await getLanceSpace(lancePath)).on_disk_bytes).toBe(space.on_disk_bytes);

  removeDir(loreRoot);
  removeDir(codePath);
});

test("status reports the superseded bytes the search index holds", async () => {
  const { engine, codePath, loreRoot, lancePath } =
    await mindWithSupersededIndex("status-lance-space");
  const space = await getLanceSpace(lancePath);

  const status = await engine.status({ codePath });

  expect(status.search_index).toBeDefined();
  expect(status.search_index?.on_disk_bytes).toBe(space.on_disk_bytes);
  expect(status.search_index?.live_bytes).toBe(space.live_bytes);
  expect(status.search_index?.superseded_bytes).toBe(space.superseded_bytes);

  removeDir(loreRoot);
  removeDir(codePath);
});

test("status omits the search index for a mind that has never searched", async () => {
  const loreRoot = createTempDir("lore-root-");
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });
  await engine.register(codePath, "status-lance-absent");

  const status = await engine.status({ codePath });

  expect(status.search_index).toBeUndefined();

  removeDir(loreRoot);
  removeDir(codePath);
});
