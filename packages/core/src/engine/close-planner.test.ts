import { expect, test } from "bun:test";

import { insertChunk } from "@/db/chunks.ts";
import { insertConcept } from "@/db/concepts.ts";
import { insertNarrative } from "@/db/narratives.ts";
import { writeJournalChunk } from "@/storage/index.ts";
import { buildExplicitClosePlan } from "./close-planner.ts";
import type { Generator } from "./generator.ts";
import type { NarrativeRow, NarrativeTarget } from "@/types/index.ts";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";

/** A generator that returns the queued bodies, then repeats the last one. */
function stubGenerator(bodies: string[]): { generator: Generator; calls: () => number } {
  let call = 0;
  const generator = {
    generateIntegration: async (): Promise<string> => {
      const body = bodies[Math.min(call, bodies.length - 1)] ?? "";
      call++;
      return body;
    },
    generate: async (): Promise<string> => "",
  };
  return { generator: generator as unknown as Generator, calls: () => call };
}

async function seedJournalEntry(
  db: ReturnType<typeof createTestDb>,
  lorePath: string,
  narrativeName: string,
  conceptName: string,
  targets: NarrativeTarget[],
): Promise<NarrativeRow> {
  const narrative = insertNarrative(db, narrativeName, "close a concept", null, targets);
  const chunk = await writeJournalChunk({
    lorePath,
    narrativeName,
    content: `A journal entry about ${conceptName}.`,
    conceptDesignations: [conceptName],
  });
  insertChunk(db, {
    id: chunk.id,
    filePath: chunk.filePath,
    flType: "journal",
    narrativeId: narrative.id,
    conceptDesignations: [conceptName],
    createdAt: new Date().toISOString(),
  });
  return narrative;
}

test("an empty body from the generator is retried once for a create", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    const narrative = await seedJournalEntry(db, lorePath, "make-alpha", "alpha", [
      { op: "create", concept: "alpha" },
    ]);
    const { generator, calls } = stubGenerator(["  \n ", "The alpha concept holds the rules."]);

    const plan = await buildExplicitClosePlan(db, narrative, generator);

    expect(calls()).toBe(2);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.content).toBe("The alpha concept holds the rules.");
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("a create that stays empty fails the plan and names the concept", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    const narrative = await seedJournalEntry(db, lorePath, "make-beta", "beta", [
      { op: "create", concept: "beta" },
    ]);
    const { generator } = stubGenerator([""]);

    await expect(buildExplicitClosePlan(db, narrative, generator)).rejects.toMatchObject({
      code: "EMPTY_CONCEPT_BODY",
      message: expect.stringContaining("beta"),
    });
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("an update whose rewrite stays empty fails the plan and names the concept", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    insertConcept(db, "gamma");
    const narrative = await seedJournalEntry(db, lorePath, "edit-gamma", "gamma", [
      { op: "update", concept: "gamma" },
    ]);
    const { generator } = stubGenerator([""]);

    await expect(buildExplicitClosePlan(db, narrative, generator)).rejects.toMatchObject({
      code: "EMPTY_CONCEPT_BODY",
      message: expect.stringContaining("gamma"),
    });
  } finally {
    db.close();
    removeDir(lorePath);
  }
});
