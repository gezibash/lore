import { test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { join } from "path";
import { createTempDir } from "../../test/support/db.ts";
import { runMigrations } from "./migrations.ts";
import {
  getMigrationStatus,
  listMigrationNames,
  migrate,
  readMigrationSql,
  splitSqlStatements,
} from "./migrator.ts";

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

test("splitSqlStatements ignores a semicolon that does not end a statement", () => {
  const cases: [string, string[]][] = [
    ["", []],
    ["   \n\n  ", []],
    [";;;", []],
    ["-- only a comment\n", []],
    ["/* only a comment */", []],
    ["SELECT 1", ["SELECT 1"]],
    ["SELECT 1;;SELECT 2;", ["SELECT 1;", "SELECT 2;"]],
    ["SELECT 1; -- trailing\n", ["SELECT 1;"]],
    ["SELECT ';';\nSELECT 2;\n", ["SELECT ';';", "SELECT 2;"]],
    ["-- one; two\nSELECT 1;\n", ["-- one; two\nSELECT 1;"]],
    ["/* one; two */ SELECT 1;\n", ["/* one; two */ SELECT 1;"]],
    ["SELECT 1--c;\n;SELECT 2;", ["SELECT 1--c;\n;", "SELECT 2;"]],
    ["SELECT 'a\nb;c';", ["SELECT 'a\nb;c';"]],
    ["SELECT 'it''s; here';\n", ["SELECT 'it''s; here';"]],
    ['SELECT "a;b" FROM t;\n', ['SELECT "a;b" FROM t;']],
    ["SELECT `a;b` FROM t;", ["SELECT `a;b` FROM t;"]],
    ["SELECT [a;b] FROM t;", ["SELECT [a;b] FROM t;"]],
    ["SELECT x'3B';", ["SELECT x'3B';"]],
    // 'trigger' as a column name must not open a trigger body.
    ["CREATE TABLE t (trigger TEXT);\nSELECT 1;", ["CREATE TABLE t (trigger TEXT);", "SELECT 1;"]],
    ["SELECT CASE WHEN 1 THEN 2 END;\nSELECT 3;", ["SELECT CASE WHEN 1 THEN 2 END;", "SELECT 3;"]],
  ];

  for (const [input, want] of cases) {
    expect({ input, got: splitSqlStatements(input) }).toEqual({ input, got: want });
  }
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

test("splitSqlStatements handles the other trigger shapes", () => {
  // A CASE in the WHEN clause closes before the body opens.
  const whenCase =
    "CREATE TRIGGER g AFTER UPDATE ON t WHEN (CASE WHEN NEW.n > 1 THEN 1 ELSE 0 END) = 1 BEGIN\n" +
    "  UPDATE t SET n = 0;\n" +
    "END;\nSELECT 1;";
  expect(splitSqlStatements(whenCase)).toHaveLength(2);

  // A CASE inside another CASE, both inside the body.
  const nestedCase =
    "CREATE TRIGGER g AFTER INSERT ON t BEGIN\n" +
    "  UPDATE t SET n = CASE WHEN 1 THEN (CASE WHEN 2 THEN 3 ELSE 4 END) ELSE 5 END;\n" +
    "END;\nSELECT 1;";
  expect(splitSqlStatements(nestedCase)).toHaveLength(2);

  const tempTrigger =
    "CREATE TEMP TRIGGER g AFTER INSERT ON t BEGIN UPDATE t SET n = 1; END;\nSELECT 1;";
  expect(splitSqlStatements(tempTrigger)).toHaveLength(2);
});

test("splitSqlStatements reproduces every migration on disk", () => {
  const whole = new Database(":memory:");
  const split = new Database(":memory:");
  const stripComments = (text: string) =>
    text
      .replace(/--[^\n]*/g, " ")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/\s+/g, " ")
      .trim();

  for (const name of listMigrationNames()) {
    const sql = readMigrationSql(name);
    whole.exec(sql);

    const statements = splitSqlStatements(sql);
    // Comments are not statements, so compare the SQL without them.
    expect(stripComments(statements.join("\n"))).toBe(stripComments(sql));
    for (const statement of statements) split.run(statement);
  }

  const dump = (db: Database) =>
    db
      .query<{ type: string; name: string; sql: string | null }, []>(
        "SELECT type, name, sql FROM sqlite_master ORDER BY type, name",
      )
      .all();
  expect(dump(split)).toEqual(dump(whole));
  expect(dump(whole).length).toBeGreaterThan(0);

  whole.close();
  split.close();
});
