import { test, expect } from "bun:test";
import { readFileSync } from "fs";
import { createTempDir, removeDir } from "../../test/support/db.ts";
import { parseChunk } from "./frontmatter.ts";
import {
  writeStateChunk,
  writeJournalChunk,
  markSuperseded,
  updateChunkFrontmatter,
} from "./chunk-writer.ts";
import type { JournalChunkFrontmatter, StateChunkFrontmatter } from "@/types/index.ts";

test("writeStateChunk writes required frontmatter and content", async () => {
  const root = createTempDir();

  const result = await writeStateChunk({
    lorePath: root,
    concept: "concept-a",
    conceptId: "cid",
    narrativeOrigin: "init",
    version: 1,
    content: "state body",
  });

  const parsed = parseChunk<StateChunkFrontmatter>(await readFileSync(result.filePath, "utf-8"));
  expect(parsed.content).toBe("state body");
  expect(parsed.frontmatter.fl_type).toBe("chunk");
  expect(parsed.frontmatter.fl_concept).toBe("concept-a");

  removeDir(root);
});

test("writeJournalChunk adds intent when provided", async () => {
  const root = createTempDir();

  const result = await writeJournalChunk({
    lorePath: root,
    narrativeName: "narrative-1",
    content: "journal entry",
    intent: "investigate",
  });

  const parsed = parseChunk<JournalChunkFrontmatter>(await readFileSync(result.filePath, "utf-8"));
  expect(parsed.frontmatter.fl_type).toBe("journal");
  expect(parsed.frontmatter.fl_intent).toBe("investigate");

  removeDir(root);
});

test("markSuperseded and updateChunkFrontmatter patch frontmatter", async () => {
  const root = createTempDir();

  const result = await writeJournalChunk({
    lorePath: root,
    narrativeName: "narrative-1",
    content: "journal entry",
    status: null,
  });

  await markSuperseded(result.filePath, "new-id");
  const firstPass = parseChunk<JournalChunkFrontmatter>(
    await readFileSync(result.filePath, "utf-8"),
  );
  expect(
    (firstPass.frontmatter as JournalChunkFrontmatter & { fl_superseded_by?: string })
      .fl_superseded_by,
  ).toBe("new-id");

  await updateChunkFrontmatter(result.filePath, { fl_topics: ["x", "y"] });
  const secondPass = parseChunk<JournalChunkFrontmatter>(
    await readFileSync(result.filePath, "utf-8"),
  );
  expect(secondPass.frontmatter.fl_topics).toEqual(["x", "y"]);

  removeDir(root);
});
