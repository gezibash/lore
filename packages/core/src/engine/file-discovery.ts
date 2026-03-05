import { spawnSync } from "child_process";
import { readdirSync, readFileSync, existsSync } from "fs";
import { join, extname, relative } from "path";
import type { SupportedLanguage, DiscoveredFile } from "@/types/index.ts";

const EXTENSION_MAP: Record<string, SupportedLanguage> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
};

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "__pycache__",
  "target",
  "vendor",
  ".lore",
  ".next",
  ".nuxt",
  "coverage",
  ".turbo",
  ".cache",
]);

function readIgnoreFile(filePath: string): string[] {
  if (!existsSync(filePath)) return [];
  try {
    return readFileSync(filePath, "utf-8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"));
  } catch {
    return [];
  }
}

function matchesPattern(pattern: string, relativePath: string): boolean {
  const p = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  if (p.endsWith("/")) {
    const prefix = p.slice(0, -1);
    return relativePath.startsWith(prefix + "/") || relativePath === prefix;
  }
  const glob = new Bun.Glob(p);
  if (glob.match(relativePath)) return true;
  const parts = relativePath.split("/");
  return parts.some((_, i) => glob.match(parts.slice(i).join("/")));
}

function buildLoreignoreFilter(codePath: string): (relativePath: string) => boolean {
  const lines = readIgnoreFile(join(codePath, ".loreignore"));
  const forceIncludes = lines.filter((l) => l.startsWith("!")).map((l) => l.slice(1));
  const excludes = lines.filter((l) => !l.startsWith("!"));
  return (relativePath: string) => {
    if (forceIncludes.some((p) => matchesPattern(p, relativePath))) return false;
    return excludes.some((p) => matchesPattern(p, relativePath));
  };
}

function isGitRepo(codePath: string): boolean {
  const result = spawnSync("git", ["-C", codePath, "rev-parse", "--is-inside-work-tree"], {
    encoding: "utf-8",
    timeout: 5000,
  });
  return result.status === 0 && result.stdout?.trim() === "true";
}

function discoverViaGit(codePath: string, shouldExclude: (p: string) => boolean): DiscoveredFile[] {
  const result = spawnSync("git", ["-C", codePath, "ls-files", "-z"], {
    encoding: "utf-8",
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  });

  if (result.status !== 0) {
    throw new Error(`git ls-files failed: ${result.stderr}`);
  }

  const files: DiscoveredFile[] = [];
  const paths = result.stdout.split("\0").filter(Boolean);

  for (const relativePath of paths) {
    if (shouldExclude(relativePath)) continue;
    const ext = extname(relativePath).toLowerCase();
    const language = EXTENSION_MAP[ext];
    if (!language) continue;

    files.push({
      relativePath,
      absolutePath: join(codePath, relativePath),
      language,
    });
  }

  return files;
}

function discoverViaWalk(codePath: string, shouldExclude: (p: string) => boolean): DiscoveredFile[] {
  const files: DiscoveredFile[] = [];

  function walk(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const relDir = relative(codePath, join(dir, entry.name));
        if (shouldExclude(relDir)) continue;
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        const language = EXTENSION_MAP[ext];
        if (!language) continue;
        const absolutePath = join(dir, entry.name);
        const relativePath = relative(codePath, absolutePath);
        if (shouldExclude(relativePath)) continue;
        files.push({ relativePath, absolutePath, language });
      }
    }
  }

  walk(codePath);
  return files;
}

export function discoverFiles(codePath: string): DiscoveredFile[] {
  const shouldExclude = buildLoreignoreFilter(codePath);
  if (isGitRepo(codePath)) {
    const files = discoverViaGit(codePath, shouldExclude);
    if (files.length > 0) return files;
    // Fall through: repo exists but has no committed files (fresh / pre-first-commit)
  }
  return discoverViaWalk(codePath, shouldExclude);
}

export function isTsxFile(filePath: string): boolean {
  const ext = extname(filePath).toLowerCase();
  return ext === ".tsx" || ext === ".jsx";
}
