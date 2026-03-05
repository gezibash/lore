import { createHash } from "crypto";
import { openDb } from "./connection.ts";
import { listMigrationNames, readMigrationSql } from "./migrator.ts";
import { inspectSchema, type SchemaSnapshot } from "./schema-inspect.ts";

export interface CanonicalSchema extends SchemaSnapshot {
  migrationNames: string[];
  migrationDigest: string;
}

function digestMigrationNames(names: string[]): string {
  return createHash("sha256").update(names.join("\n")).digest("hex");
}

export function buildCanonicalSchemaFromMigrations(): CanonicalSchema {
  const shadow = openDb(":memory:");
  try {
    const migrationNames = listMigrationNames();
    for (const name of migrationNames) {
      shadow.exec(readMigrationSql(name));
    }

    const schema = inspectSchema(shadow);
    return {
      ...schema,
      migrationNames,
      migrationDigest: digestMigrationNames(migrationNames),
    };
  } finally {
    shadow.close();
  }
}
