import { expect, test } from "bun:test";
import { resolveConfig } from "@/config/index.ts";
import { insertNarrativeRaw } from "@/db/narratives.ts";
import { openNarrative } from "./narrative-lifecycle.ts";
import { createTestDb } from "../../test/support/db.ts";

test("openNarrative rejects unsupported dangling resolution actions", async () => {
  const db = createTestDb();
  const config = resolveConfig();
  const openedAt = new Date(
    Date.now() - (config.thresholds.dangling_days + 1) * 24 * 60 * 60 * 1000,
  ).toISOString();

  insertNarrativeRaw(db, "dangling-id", "old-work", {
    intent: "stale narrative",
    status: "open",
    entryCount: 0,
    openedAt,
  });

  await expect(
    openNarrative(
      db,
      "/tmp/lore-test",
      "new-work",
      "continue",
      config,
      {} as never,
      { narrative: "old-work", action: "close" as never },
    ),
  ).rejects.toMatchObject({ code: "DANGLING_NARRATIVE" });
});
