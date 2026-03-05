import { expect, test } from "bun:test";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { writeTextFile } from "../../test/support/files.ts";
import { scanProject } from "./scanner.ts";
import { getSourceFileByPath } from "@/db/source-files.ts";
import { getSourceChunkPathsForFile } from "@/db/chunks.ts";

test("scanProject preserves existing source state when replacement source chunks cannot be staged", async () => {
  const db = createTestDb();
  const codeDir = createTempDir("lore-code-");
  const loreDir = createTempDir("lore-lore-");
  const badLoreRoot = `${createTempDir("lore-bad-")}/not-a-directory`;
  const filePath = `${codeDir}/src/example.ts`;

  try {
    writeTextFile(filePath, "export function example() { return 1; }\n");
    const first = await scanProject(db, codeDir, loreDir);
    expect(first.files_failed).toBe(0);

    const existing = getSourceFileByPath(db, "src/example.ts");
    expect(existing).not.toBeNull();
    const oldSourceChunks = getSourceChunkPathsForFile(db, "src/example.ts");
    expect(oldSourceChunks.length).toBeGreaterThan(0);

    writeTextFile(badLoreRoot, "blocked");
    writeTextFile(filePath, "export function example() { return 2; }\n");

    const failed = await scanProject(db, codeDir, badLoreRoot);
    expect(failed.files_failed).toBe(1);

    const after = getSourceFileByPath(db, "src/example.ts");
    expect(after).not.toBeNull();
    expect(after?.content_hash).toBe(existing?.content_hash);
    expect(getSourceChunkPathsForFile(db, "src/example.ts")).toEqual(oldSourceChunks);
  } finally {
    db.close();
    removeDir(codeDir);
    removeDir(loreDir);
    removeDir(badLoreRoot.split("/not-a-directory")[0]!);
  }
});
