import type { Database } from "bun:sqlite";
import { migrate } from "./migrator.ts";

export function runMigrations(db: Database): number {
  return migrate(db);
}
