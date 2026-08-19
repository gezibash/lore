import { expect, test } from "bun:test";
import { createTestDb } from "../../test/support/db.ts";
import {
  getNarrativeByName,
  getOpenNarrativeByName,
  insertNarrative,
  setNarrativeStatus,
} from "./narratives.ts";

test("getNarrativeByName prefers an actionable narrative over an abandoned twin", () => {
  const db = createTestDb();
  try {
    // Same name, two ids — current_narratives keys by id, so both stay "current".
    const abandoned = insertNarrative(db, "dup-name", "first attempt");
    setNarrativeStatus(db, abandoned.id, "abandoned");
    const live = insertNarrative(db, "dup-name", "second attempt");

    // Unordered, this returned the abandoned row, so close refused a narrative
    // that status still counted as dangling — which blocks `lore open` entirely.
    expect(getNarrativeByName(db, "dup-name")?.id).toBe(live.id);
    expect(getOpenNarrativeByName(db, "dup-name")?.id).toBe(live.id);
  } finally {
    db.close();
  }
});
