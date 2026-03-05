import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

function walkTsFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...walkTsFiles(path));
      continue;
    }
    if (path.endsWith(".ts")) files.push(path);
  }
  return files;
}

test("cli source imports only adapter-layer packages (no @lore/core or @lore/sdk)", () => {
  const files = walkTsFiles(import.meta.dir);
  const offenders: string[] = [];

  for (const file of files) {
    if (file.endsWith("sdk-boundary.test.ts")) continue;
    const content = readFileSync(file, "utf-8");
    if (content.includes("@lore/core") || content.includes("@lore/sdk")) {
      offenders.push(file);
    }
  }

  expect(offenders).toEqual([]);
});
