import { test, expect } from "bun:test";
import { join } from "path";
import { mkdirSync } from "fs";
import { createTempDir, createTestDb, removeDir } from "../../test/support/db.ts";
import { insertNarrative } from "@/db/narratives.ts";
import { healthCheck, verifyIntegrity } from "./startup.ts";

const embedder = {
  healthCheck: async () => true,
};

test("healthCheck returns ai/db status and open narrative count", async () => {
  const db = createTestDb();
  insertNarrative(db, "alpha", "test intent", null);

  const report = await healthCheck(db, embedder);

  expect(report.dbOk).toBe(true);
  expect(report.aiOk).toBe(true);
  expect(report.lore_minds).toHaveLength(1);
  expect(report.lore_minds[0]!.openNarratives).toBe(1);
  expect(report.lore_minds[0]!.name).toBe("current");

  db.close();
});

test("verifyIntegrity reports missing main and journals", async () => {
  const db = createTestDb();
  const lorePath = createTempDir();
  insertNarrative(db, "alpha", "intent", null);

  const result = await verifyIntegrity(db, lorePath);

  expect(result.ok).toBe(false);
  expect(result.issues).toContain("main/ directory missing");
  expect(
    result.issues.some((issue) =>
      issue.includes("Journal directory missing for narrative 'alpha'"),
    ),
  ).toBe(true);

  db.close();
  removeDir(lorePath);
});

test("verifyIntegrity passes when required dirs exist", async () => {
  const db = createTestDb();
  const lorePath = createTempDir();

  mkdirSync(join(lorePath, "main"), { recursive: true });
  const narrative = insertNarrative(db, "beta", "intent", null);
  mkdirSync(join(lorePath, "delta", narrative.name, "journal"), { recursive: true });

  const result = await verifyIntegrity(db, lorePath);

  expect(result.ok).toBe(true);
  expect(result.issues).toEqual([]);

  db.close();
  removeDir(lorePath);
});
