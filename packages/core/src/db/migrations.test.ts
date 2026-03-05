import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations.ts";
import { getMigrationStatus, listMigrationNames } from "./migrator.ts";

test("migrate applies pending migrations once", () => {
  const db = new Database(":memory:");

  const first = runMigrations(db);
  const second = runMigrations(db);
  const status = getMigrationStatus(db);

  expect(first).toBeGreaterThan(0);
  expect(second).toBe(0);
  expect(status.pending).toEqual([]);
  expect(status.applied.length).toBeGreaterThan(0);

  db.close();
});

test("getMigrationStatus does not auto-stamp 001_initial from existing schema", () => {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE manifest (version_id TEXT PRIMARY KEY)");

  const status = getMigrationStatus(db);
  expect(status.applied).toEqual([]);
  expect(status.pending).toEqual(listMigrationNames());

  db.close();
});
