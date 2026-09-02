import { expect, test } from "bun:test";

import { insertChunk } from "@/db/chunks.ts";
import { insertConcept } from "@/db/concepts.ts";
import { insertNarrative } from "@/db/narratives.ts";
import { writeJournalChunk, writeStateChunk } from "@/storage/index.ts";
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
  entry?: string,
): Promise<NarrativeRow> {
  const narrative = insertNarrative(db, narrativeName, "close a concept", null, targets);
  const chunk = await writeJournalChunk({
    lorePath,
    narrativeName,
    content: entry ?? `A journal entry about ${conceptName}.`,
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

/** Records what each strategy hands the generator. */
function recordingGenerator(body: string, patchOps = "") {
  const existingStateSeen: string[][] = [];
  const strategiesSeen: Array<string | undefined> = [];
  const generator = {
    generateIntegration: async (
      _entries: string[],
      existingState: string[],
      _conceptName?: string,
      strategy?: string,
    ): Promise<string> => {
      existingStateSeen.push(existingState);
      strategiesSeen.push(strategy);
      return body;
    },
    generate: async (): Promise<string> => patchOps,
  };
  return { generator: generator as unknown as Generator, existingStateSeen, strategiesSeen };
}

async function seedActiveConcept(
  db: ReturnType<typeof createTestDb>,
  lorePath: string,
  conceptName: string,
  body: string,
): Promise<void> {
  const concept = insertConcept(db, conceptName);
  const chunk = await writeStateChunk({
    lorePath,
    concept: conceptName,
    conceptId: concept.id,
    narrativeOrigin: "seed",
    version: 1,
    content: body,
  });
  insertChunk(db, {
    id: chunk.id,
    filePath: chunk.filePath,
    flType: "chunk",
    conceptId: concept.id,
    createdAt: new Date().toISOString(),
  });
  db.run("UPDATE concepts SET active_chunk_id = ? WHERE id = ?", [chunk.id, concept.id]);
}

const EXISTING_BODY = "The timeout is 10 seconds.\n\nRetries use exponential backoff.";

test("replace writes a new body and never sees the prose it replaces", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    await seedActiveConcept(db, lorePath, "delta", EXISTING_BODY);
    const narrative = await seedJournalEntry(db, lorePath, "redo-delta", "delta", [
      { op: "update", concept: "delta" },
    ]);
    const { generator, existingStateSeen } = recordingGenerator("The timeout is 30 seconds.", "[]");

    const plan = await buildExplicitClosePlan(db, narrative, generator, "replace");

    expect(existingStateSeen).toEqual([[]]);
    expect(plan.updates[0]!.strategy).toBe("rewrite");
    expect(plan.updates[0]!.newContent).toBe("The timeout is 30 seconds.");
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("the default strategy keeps the paragraphs the entries do not touch", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    await seedActiveConcept(db, lorePath, "epsilon", EXISTING_BODY);
    const narrative = await seedJournalEntry(
      db,
      lorePath,
      "tune-epsilon",
      "epsilon",
      [{ op: "update", concept: "epsilon" }],
      "The timeout is now 30 seconds, not 10 seconds.",
    );
    const { generator, existingStateSeen } = recordingGenerator(
      "unused rewrite",
      '[{"op":"replace","block_id":"b1","content":"The timeout is 30 seconds."}]',
    );

    const plan = await buildExplicitClosePlan(db, narrative, generator);

    expect(existingStateSeen).toEqual([]);
    expect(plan.updates[0]!.strategy).toBe("patch");
    expect(plan.updates[0]!.newContent).toContain("Retries use exponential backoff.");
    expect(plan.updates[0]!.newContent).toContain("The timeout is 30 seconds.");
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("correct rewrites from the existing prose", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    await seedActiveConcept(db, lorePath, "zeta", EXISTING_BODY);
    const narrative = await seedJournalEntry(db, lorePath, "fix-zeta", "zeta", [
      { op: "update", concept: "zeta" },
    ]);
    const { generator, existingStateSeen } = recordingGenerator("The timeout is 30 seconds.", "[]");

    const plan = await buildExplicitClosePlan(db, narrative, generator, "correct");

    expect(existingStateSeen).toEqual([[EXISTING_BODY]]);
    expect(plan.updates[0]!.strategy).toBe("rewrite");
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

/**
 * `patch` asks the generator to keep the paragraphs the entries do not touch.
 * A create has none, so the model answered by asking for the state it was
 * never given, and the concept landed holding that sentence instead of a body.
 */
test("a create writes with replace, whatever strategy the close was given", async () => {
  const db = createTestDb();
  const lorePath = createTempDir("lore-planner-");
  try {
    const narrative = await seedJournalEntry(db, lorePath, "make-gamma", "gamma", [
      { op: "create", concept: "gamma" },
    ]);
    const { generator, strategiesSeen } = recordingGenerator("The gamma concept holds the rules.");

    const plan = await buildExplicitClosePlan(db, narrative, generator, "patch");

    expect(strategiesSeen).toEqual(["replace"]);
    expect(plan.creates).toHaveLength(1);
    expect(plan.creates[0]!.content).toBe("The gamma concept holds the rules.");
  } finally {
    db.close();
    removeDir(lorePath);
  }
});

test("a create ignores extend and correct too", async () => {
  for (const asked of ["extend", "correct"] as const) {
    const db = createTestDb();
    const lorePath = createTempDir("lore-planner-");
    try {
      const narrative = await seedJournalEntry(db, lorePath, `make-${asked}`, "delta", [
        { op: "create", concept: "delta" },
      ]);
      const { generator, strategiesSeen } = recordingGenerator(
        "The delta concept holds the rules.",
      );

      await buildExplicitClosePlan(db, narrative, generator, asked);

      expect(strategiesSeen).toEqual(["replace"]);
    } finally {
      db.close();
      removeDir(lorePath);
    }
  }
});
