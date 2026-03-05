import { readdirSync, readFileSync, existsSync } from "fs";
import { join, extname, relative } from "path";

const TEXT_EXTENSIONS = new Set([
  ".md", ".mdx", ".txt", ".rst", ".yaml", ".yml", ".json", ".toml", ".adoc",
]);

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".lore", "dist", "build", "__pycache__", "target",
  "vendor", ".next", ".nuxt", "coverage", ".turbo", ".cache",
]);

export interface DiscoveredTextFile {
  relativePath: string;
  absolutePath: string;
}

/**
 * Match a gitignore-style pattern against a file path.
 * Supports simple glob patterns using Bun.Glob.
 */
function matchesPattern(pattern: string, relativePath: string): boolean {
  // Strip leading slash from patterns like /foo
  const p = pattern.startsWith("/") ? pattern.slice(1) : pattern;
  // Directory pattern: foo/ matches anything under foo/
  if (p.endsWith("/")) {
    const prefix = p.slice(0, -1);
    return relativePath.startsWith(prefix + "/") || relativePath === prefix;
  }
  // Glob match
  const glob = new Bun.Glob(p);
  if (glob.match(relativePath)) return true;
  // Also try matching just the filename portion
  const parts = relativePath.split("/");
  return parts.some((_, i) => glob.match(parts.slice(i).join("/")));
}

/**
 * Read a .gitignore or .loreignore file and return its non-empty, non-comment lines.
 */
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

/**
 * Discover text files under codePath, respecting .gitignore and .loreignore.
 *
 * .loreignore takes highest authority:
 *   - Lines starting with `!` = force-include (overrides gitignore exclusions)
 *   - Other lines = additional exclusions (on top of gitignore)
 */
export function discoverTextFiles(codePath: string, _lorePath?: string): DiscoveredTextFile[] {
  // Skip negation lines (e.g. !vendor/...) — Bun.Glob interprets ! as negation,
  // which would incorrectly match most paths.
  const gitignorePatterns = readIgnoreFile(join(codePath, ".gitignore")).filter(
    (l) => !l.startsWith("!"),
  );
  const loreignoreLines = readIgnoreFile(join(codePath, ".loreignore"));

  // Split loreignore into force-includes and extra-excludes
  const loreForceIncludes = loreignoreLines
    .filter((l) => l.startsWith("!"))
    .map((l) => l.slice(1));
  const loreExtraExcludes = loreignoreLines.filter((l) => !l.startsWith("!"));

  function shouldExclude(relativePath: string): boolean {
    // .loreignore force-include wins over everything
    if (loreForceIncludes.some((p) => matchesPattern(p, relativePath))) return false;
    // .loreignore extra exclusions
    if (loreExtraExcludes.some((p) => matchesPattern(p, relativePath))) return true;
    // .gitignore exclusions
    if (gitignorePatterns.some((p) => matchesPattern(p, relativePath))) return true;
    return false;
  }

  const files: DiscoveredTextFile[] = [];

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
        walk(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (!TEXT_EXTENSIONS.has(ext)) continue;
        const absolutePath = join(dir, entry.name);
        const relativePath = relative(codePath, absolutePath);
        if (shouldExclude(relativePath)) continue;
        files.push({ relativePath, absolutePath });
      }
    }
  }

  walk(codePath);
  return files;
}
