import { expect, test, describe } from "bun:test";
import { insertNarrative } from "@/db/narratives.ts";
import { insertConcept } from "@/db/index.ts";
import type { LoreConfig } from "@/types/index.ts";
import { INBOX_NARRATIVE, chooseNarrative, routeConcept } from "./note-routing.ts";
import { createTestDb } from "../../test/support/db.ts";

/** routeConcept only reaches search when more than one candidate survives, so
 *  the tests that never get there can pass a config and embedder that throw. */
const UNUSED_CONFIG = { ai: { embedding: { model: "test" } } } as unknown as LoreConfig;
const UNUSED_EMBEDDER = {
  embed: () => {
    throw new Error("search must not run for this case");
  },
};

describe("chooseNarrative", () => {
  test("one open narrative takes the note", () => {
    const db = createTestDb();
    insertNarrative(db, "auth-work", "update auth", null, [
      { op: "update", concept: "auth-model" },
    ]);

    const choice = chooseNarrative(db);
    expect(choice.kind).toBe("open");
    if (choice.kind === "open") expect(choice.narrative.name).toBe("auth-work");

    db.close();
  });

  test("no open narrative sends the note to the inbox", () => {
    const db = createTestDb();
    expect(chooseNarrative(db)).toEqual({ kind: "inbox", reason: "none-open" });
    db.close();
  });

  test("several open narratives send the note to the inbox", () => {
    const db = createTestDb();
    insertNarrative(db, "auth-work", "update auth");
    insertNarrative(db, "cache-work", "update cache");

    // Guessing between them would file the note under the wrong session, and
    // refusing would lose it. The inbox is triaged at close.
    expect(chooseNarrative(db)).toEqual({ kind: "inbox", reason: "many-open" });

    db.close();
  });

  test("the inbox does not count as the one open narrative", () => {
    const db = createTestDb();
    insertNarrative(db, INBOX_NARRATIVE, "unfiled");
    insertNarrative(db, "auth-work", "update auth");

    // Otherwise the first note opens the inbox and every note after it reads
    // as two open narratives, so nothing ever reaches the real session.
    const choice = chooseNarrative(db);
    expect(choice.kind).toBe("open");
    if (choice.kind === "open") expect(choice.narrative.name).toBe("auth-work");

    db.close();
  });
});

describe("routeConcept", () => {
  test("a single target is left to the narrative's own inference", async () => {
    const db = createTestDb();
    insertConcept(db, "auth-model");
    const narrative = insertNarrative(db, "auth-work", "update auth", null, [
      { op: "update", concept: "auth-model" },
    ]);

    // journal-routing already infers this. Routing it again would spend an
    // embedding to reach the same answer.
    const routing = await routeConcept(db, UNUSED_EMBEDDER, UNUSED_CONFIG, narrative, "anything");
    expect(routing).toEqual({ kind: "inherit" });

    db.close();
  });

  test("a lone concept is chosen without searching", async () => {
    const db = createTestDb();
    insertConcept(db, "auth-model");
    const narrative = insertNarrative(db, "explore", "look around");

    const routing = await routeConcept(db, UNUSED_EMBEDDER, UNUSED_CONFIG, narrative, "anything");
    expect(routing).toEqual({ kind: "only", concept: "auth-model" });

    db.close();
  });

  test("a lore with no concept says so instead of inventing one", async () => {
    const db = createTestDb();
    const narrative = insertNarrative(db, "explore", "look around");

    await expect(
      routeConcept(db, UNUSED_EMBEDDER, UNUSED_CONFIG, narrative, "anything"),
    ).rejects.toThrow(/no concept to file a note against/i);

    db.close();
  });

  test("a note that matches no declared target is refused, not guessed", async () => {
    const db = createTestDb();
    insertConcept(db, "auth-model");
    insertConcept(db, "cache-layer");
    const narrative = insertNarrative(db, "auth-work", "update auth", null, [
      { op: "update", concept: "auth-model" },
      { op: "update", concept: "cache-layer" },
    ]);

    // Nothing is embedded in this lore, so search returns nothing and no
    // candidate wins. Filing the note anyway would state something about a
    // concept the note does not describe.
    await expect(
      routeConcept(
        db,
        { embed: async () => new Float32Array(8) },
        { ai: { embedding: { model: "test" } } } as unknown as LoreConfig,
        narrative,
        "something unrelated",
      ),
    ).rejects.toThrow(/auth-model, cache-layer/);

    db.close();
  });
});
