import { expect, test } from "bun:test";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { ingestDocFile } from "./ingester.ts";
import { getDocChunkByPath } from "@/db/chunks.ts";

test("ingestDocFile preserves the existing doc chunk when replacement staging fails", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const badLoreRoot = `${createTempDir("lore-bad-")}/not-a-directory`;
  const docPath = `${codeDir}/README.md`;

  try {
    writeTextFile(docPath, "# First\n");
    const first = await ingestDocFile(db, codeDir, loreDir, docPath);
    expect(first).toBe("ingested");

    const existing = getDocChunkByPath(db, "README.md");
    expect(existing).not.toBeNull();

    writeTextFile(badLoreRoot, "blocked");
    writeTextFile(docPath, "# Second\n");

    const failed = await ingestDocFile(db, codeDir, badLoreRoot, docPath);
    expect(failed).toBe("failed");

    const after = getDocChunkByPath(db, "README.md");
    expect(after).not.toBeNull();
    expect(after?.id).toBe(existing?.id);
    expect(after?.file_path).toBe(existing?.file_path);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
    removeDir(badLoreRoot.split("/not-a-directory")[0]!);
  }
});
