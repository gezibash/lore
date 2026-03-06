import { expect, test } from "bun:test";
import { join } from "path";
import { LoreEngine } from "./index.ts";
import { openDb } from "@/db/connection.ts";
import { getChunk, getOpenNarrativeByName, insertChunk } from "@/db/index.ts";
import { readChunk, writeJournalChunk } from "@/storage/index.ts";
import { createTempDir, removeDir } from "../../test/support/db.ts";

test("designateJournalEntry repairs an unresolved journal chunk by chunk id", async () => {
  const loreRoot = createTempDir("lore-root-");
  const codePath = createTempDir("lore-code-");
  const engine = new LoreEngine({ lore_root: loreRoot });

  try {
    const registered = await engine.register(codePath, "repair-target");
    await engine.open("repair-routing", "Repair unresolved entry", {
      codePath,
      targets: [{ op: "create", concept: "auth-model" }],
    });

    const db = openDb(join(registered.lore_path, "lore.db"));
    try {
      const narrative = getOpenNarrativeByName(db, "repair-routing");
      expect(narrative).toBeTruthy();

      const chunk = await writeJournalChunk({
        lorePath: registered.lore_path,
        narrativeName: "repair-routing",
        content: "Legacy journal entry without concept designations.",
        topics: ["legacy"],
      });
      insertChunk(db, {
        id: chunk.id,
        filePath: chunk.filePath,
        flType: "journal",
        narrativeId: narrative!.id,
        topics: ["legacy"],
        createdAt: new Date().toISOString(),
      });

      const result = await engine.designateJournalEntry("repair-routing", chunk.id, {
        codePath,
        concepts: ["auth-model"],
      });

      expect(result.concepts).toEqual(["auth-model"]);

      const updatedRow = getChunk(db, chunk.id);
      expect(updatedRow?.concept_designations).toBe(JSON.stringify(["auth-model"]));
      expect(updatedRow?.concept_refs).toBeNull();

      const parsed = await readChunk(chunk.filePath);
      const frontmatter = parsed.frontmatter as {
        fl_concept_designations?: string[];
        fl_topics?: string[];
      };
      expect(frontmatter.fl_concept_designations).toEqual(["auth-model"]);
      expect(frontmatter.fl_topics).toEqual(["legacy"]);
    } finally {
      db.close();
    }
  } finally {
    engine.shutdown();
    removeDir(loreRoot);
    removeDir(codePath);
  }
});
