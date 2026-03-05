import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { dirname, join, relative, resolve } from "path";

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

function importSpecifiers(content: string): string[] {
  const specs: string[] = [];
  const re =
    /(?:import|export)\s+(?:type\s+)?(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
  for (const match of content.matchAll(re)) {
    const spec = match[1] ?? match[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

test("mcp source imports only allowed public lore packages and local files", () => {
  const files = walkTsFiles(import.meta.dir);
  const offenders: string[] = [];
  const packageRoot = resolve(import.meta.dir, "..");
  const allowedLoreImports = new Set(["@lore/rendering", "@lore/worker"]);

  for (const file of files) {
    if (file.endsWith("sdk-boundary.test.ts")) continue;
    for (const spec of importSpecifiers(readFileSync(file, "utf-8"))) {
      if (spec.startsWith("@/")) {
        offenders.push(`${file}: forbidden core alias ${spec}`);
        continue;
      }
      if (spec.startsWith("@lore/") && !allowedLoreImports.has(spec)) {
        offenders.push(`${file}: forbidden lore import ${spec}`);
        continue;
      }
      if (!spec.startsWith(".")) continue;
      const target = resolve(dirname(file), spec);
      if (relative(packageRoot, target).startsWith("..")) {
        offenders.push(`${file}: cross-package relative import ${spec}`);
      }
    }
  }

  expect(offenders).toEqual([]);
});
