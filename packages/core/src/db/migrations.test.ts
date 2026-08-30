import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { join } from "path";
import { createTempDir } from "../../test/support/db.ts";
import { runMigrations } from "./migrations.ts";
import { getMigrationStatus, listMigrationNames, migrate, splitSqlStatements } from "./migrator.ts";

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

/** A migrations directory holding one file, so a test can watch what `migrate`
 *  does with the statements in it. */
function writeMigration(sql: string): string {
  const dir = createTempDir("lore-migrations-");
  writeFileSync(join(dir, "001_initial.sql"), sql);
  return dir;
}

test("migrate raises when a data statement fails and leaves the migration pending", () => {
  const dir = writeMigration(
    "CREATE TABLE parts (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n" +
      "INSERT INTO parts (id, state) VALUES ('a', 'new');\n" +
      "UPDATE parts SET state = NULL;\n",
  );
  const db = new Database(":memory:");

  expect(() => migrate(db, dir)).toThrow(/NOT NULL/);
  expect(getMigrationStatus(db, dir).pending).toEqual(["001_initial"]);

  db.close();
});

test("migrate raises for a failed statement that is not the last one", () => {
  const dir = writeMigration(
    "CREATE TABLE parts (id TEXT PRIMARY KEY);\n" +
      "INSERT INTO parts (id) VALUES ('a');\n" +
      "INSERT INTO parts (id) VALUES ('a');\n" +
      "INSERT INTO parts (id) VALUES ('b');\n",
  );
  const db = new Database(":memory:");

  expect(() => migrate(db, dir)).toThrow(/UNIQUE/);

  db.close();
});

test("migrate applies every statement in a file", () => {
  const dir = writeMigration(
    "CREATE TABLE parts (id TEXT PRIMARY KEY, state TEXT NOT NULL);\n" +
      "INSERT INTO parts (id, state) VALUES ('a', 'new');\n" +
      "UPDATE parts SET state = 'ready';\n" +
      "-- a trailing comment, which is not a statement\n",
  );
  const db = new Database(":memory:");

  expect(migrate(db, dir)).toBe(1);
  expect(db.query<{ state: string }, []>("SELECT state FROM parts").get()?.state).toBe("ready");

  db.close();
});

test("splitSqlStatements keeps a semicolon inside a literal or a comment", () => {
  expect(splitSqlStatements("SELECT ';';\nSELECT 2;\n")).toEqual(["SELECT ';';", "SELECT 2;"]);
  expect(splitSqlStatements("-- one; two\nSELECT 1;\n")).toEqual(["-- one; two\nSELECT 1;"]);
  expect(splitSqlStatements("/* one; two */ SELECT 1;\n")).toEqual(["/* one; two */ SELECT 1;"]);
  expect(splitSqlStatements('SELECT "a;b" FROM t;\n')).toEqual(['SELECT "a;b" FROM t;']);
  expect(splitSqlStatements("SELECT 'it''s; here';\n")).toEqual(["SELECT 'it''s; here';"]);
});

test("splitSqlStatements keeps a trigger body in one statement", () => {
  const sql =
    "CREATE TABLE t (id TEXT PRIMARY KEY, n INTEGER);\n" +
    "CREATE TRIGGER bump AFTER INSERT ON t BEGIN\n" +
    "  UPDATE t SET n = CASE WHEN NEW.n IS NULL THEN 0 ELSE NEW.n END;\n" +
    "  UPDATE t SET n = n + 1;\n" +
    "END;\n" +
    "INSERT INTO t (id, n) VALUES ('a', 5);\n";

  const statements = splitSqlStatements(sql);
  expect(statements).toHaveLength(3);
  expect(statements[1]).toContain("END;");
  expect(statements[2]).toBe("INSERT INTO t (id, n) VALUES ('a', 5);");

  // The split has to be runnable, not just correctly counted.
  const db = new Database(":memory:");
  for (const statement of statements) db.run(statement);
  expect(db.query<{ n: number }, []>("SELECT n FROM t").get()?.n).toBe(6);
  db.close();
});
