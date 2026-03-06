import type { Database } from "bun:sqlite";
import type { BootstrapPlan, BootstrapPhase, SymbolKind } from "@/types/index.ts";
import {
  getUncoveredSymbols,
  getFileCoverage,
  getCoverageStats,
  getExportedFilePaths,
} from "@/db/concept-symbols.ts";
import { getAllSourceFiles } from "@/db/source-files.ts";
import { readFileSync } from "node:fs";

interface FileGroup {
  file_path: string;
  symbols: Array<{ name: string; kind: SymbolKind }>;
}

interface DirGroup {
  directory: string;
  files: FileGroup[];
  totalUncovered: number;
  score: number;
}

function directoryPrefix(filePath: string): string {
  const parts = filePath.split("/");
  // Use first 2 path segments as directory group
  // e.g. "src/types/index.ts" -> "src/types"
  // e.g. "lib/utils.ts" -> "lib"
  if (parts.length <= 2) return parts[0] ?? ".";
  return parts.slice(0, 2).join("/");
}

function directoryDepth(dir: string): number {
  return dir.split("/").length;
}

function kindWeight(kind: SymbolKind): number {
  switch (kind) {
    case "interface":
    case "type":
    case "enum":
      return 3;
    case "class":
    case "struct":
    case "trait":
      return 1.5;
    case "function":
      return 1;
    case "method":
    case "impl":
      return 0.5;
    default:
      return 1;
  }
}

// ─── Import Extraction & Dependency Graph ────────────────

/** Regex: capture module specifier from import/export ... from '...' */
const TS_IMPORT_RE = /(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/g;

/** Regex: capture relative Python imports like `from .utils import x` or `from ..config import y` */
const PY_RELATIVE_IMPORT_RE = /from\s+(\.+[\w.]*)\s+import/g;

export function resolvePythonImportPath(
  importerPath: string,
  importSpecifier: string,
): string | null {
  // Count leading dots: 1 = current dir, 2 = parent, etc.
  let dots = 0;
  while (dots < importSpecifier.length && importSpecifier[dots] === ".") dots++;
  const remainder = importSpecifier.slice(dots);

  const parts = importerPath.split("/").slice(0, -1); // importer's directory
  // Go up (dots - 1) levels: 1 dot = same dir, 2 dots = parent, etc.
  for (let i = 1; i < dots; i++) {
    parts.pop();
  }
  if (remainder) {
    // Convert Python dotted path to slash-separated
    parts.push(...remainder.split("."));
  }
  return parts.length > 0 ? parts.join("/") : null;
}

export function extractRelativeImports(content: string, language: string): string[] {
  if (language === "typescript" || language === "javascript") {
    const imports: string[] = [];
    for (const match of content.matchAll(TS_IMPORT_RE)) {
      const specifier = match[1]!;
      if (specifier.startsWith(".")) imports.push(specifier);
    }
    return imports;
  }
  if (language === "python") {
    const imports: string[] = [];
    for (const match of content.matchAll(PY_RELATIVE_IMPORT_RE)) {
      imports.push(match[1]!);
    }
    return imports;
  }
  return [];
}

export function resolveImportPath(importerPath: string, importSpecifier: string): string | null {
  const dir = importerPath.split("/").slice(0, -1).join("/");
  const raw = dir ? dir + "/" + importSpecifier : importSpecifier;
  const segments = raw.split("/");
  const resolved: string[] = [];
  for (const seg of segments) {
    if (seg === ".") continue;
    if (seg === "..") {
      resolved.pop();
      continue;
    }
    resolved.push(seg);
  }
  return resolved.length > 0 ? resolved.join("/") : null;
}

function detectLanguage(filePath: string): string {
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx")) return "javascript";
  if (filePath.endsWith(".py")) return "python";
  return "other";
}

export function computeDependencyBoost(
  sourceFiles: Array<{ file_path: string; language?: string }>,
  codePath: string,
): Map<string, number> {
  const knownPaths = new Set(sourceFiles.map((f) => f.file_path));
  const dependedOnBy = new Map<string, Set<string>>();

  for (const sf of sourceFiles) {
    const absPath = codePath + "/" + sf.file_path;
    let content: string;
    try {
      content = readFileSync(absPath, "utf-8");
    } catch {
      continue;
    }
    const lang = sf.language ?? detectLanguage(sf.file_path);
    const relImports = extractRelativeImports(content, lang);
    const fromDir = directoryPrefix(sf.file_path);

    for (const imp of relImports) {
      let r: string | null;
      let candidates: string[];
      if (lang === "python") {
        r = resolvePythonImportPath(sf.file_path, imp);
        if (!r) continue;
        candidates = [r + ".py", r + "/__init__.py", r];
      } else {
        r = resolveImportPath(sf.file_path, imp);
        if (!r) continue;
        candidates = [r, r + ".ts", r + ".tsx", r + "/index.ts", r + ".js"];
      }
      let targetPath: string | null = null;
      for (const candidate of candidates) {
        if (knownPaths.has(candidate)) {
          targetPath = candidate;
          break;
        }
      }
      if (!targetPath) continue;
      const toDir = directoryPrefix(targetPath);
      if (fromDir === toDir) continue; // skip intra-directory imports
      let set = dependedOnBy.get(toDir);
      if (!set) {
        set = new Set();
        dependedOnBy.set(toDir, set);
      }
      set.add(fromDir);
    }
  }

  const boost = new Map<string, number>();
  for (const [dir, dependents] of dependedOnBy) {
    boost.set(dir, dependents.size);
  }
  return boost;
}

function scoreGroup(group: DirGroup, depBoost?: number): number {
  const depth = directoryDepth(group.directory);
  const depthScore = (10 - Math.min(depth, 9)) * 100;
  const countScore = group.totalUncovered * 10;
  let totalKindWeight = 0;
  for (const file of group.files) {
    for (const sym of file.symbols) {
      totalKindWeight += kindWeight(sym.kind);
    }
  }
  const dependencyScore = (depBoost ?? 0) * 200;
  return depthScore + countScore + totalKindWeight + dependencyScore;
}

function phaseRationale(group: DirGroup, index: number, depBoost?: number): string {
  const depth = directoryDepth(group.directory);
  const typeCount = group.files.reduce(
    (acc, f) =>
      acc +
      f.symbols.filter((s) => s.kind === "interface" || s.kind === "type" || s.kind === "enum")
        .length,
    0,
  );

  const parts: string[] = [];
  if (index === 0) parts.push("Start here:");
  if (depth <= 2) parts.push("shallow directory (foundational)");
  if (typeCount > 0) parts.push(`${typeCount} type definitions`);
  if (depBoost && depBoost > 0) parts.push(`imported by ${depBoost} other directories`);
  if (group.totalUncovered >= 10) parts.push("high symbol density");
  if (parts.length === 0) parts.push("uncovered exports need documentation");
  return parts.join(", ");
}

export function computeBootstrapPlan(db: Database, codePath?: string): BootstrapPlan {
  const now = new Date().toISOString();

  let stats;
  let uncovered;
  let fileCoverage;
  try {
    stats = getCoverageStats(db);
    uncovered = getUncoveredSymbols(db, { exportedOnly: true, limit: 1000 });
    fileCoverage = getFileCoverage(db);
  } catch {
    // symbols/concept_symbols tables may not exist yet
    return {
      phases: [],
      progress: {
        total_exported: 0,
        covered_exported: 0,
        coverage_ratio: 0,
        phases_complete: 0,
        phases_total: 0,
      },
      computed_at: now,
    };
  }

  // Compute incremental progress: count all dirs with exported symbols vs uncovered dirs
  let allExportedDirs: Set<string>;
  try {
    const allExportedPaths = getExportedFilePaths(db);
    allExportedDirs = new Set(allExportedPaths.map((p) => directoryPrefix(p)));
  } catch {
    allExportedDirs = new Set();
  }

  if (uncovered.length === 0) {
    return {
      phases: [],
      progress: {
        total_exported: stats.total_exported,
        covered_exported: stats.bound_exported,
        coverage_ratio: stats.total_exported > 0 ? stats.bound_exported / stats.total_exported : 1,
        phases_complete: allExportedDirs.size,
        phases_total: allExportedDirs.size,
      },
      computed_at: now,
    };
  }

  // Compute dependency boost when codePath is available
  let depBoostMap: Map<string, number> | undefined;
  if (codePath) {
    try {
      const sourceFiles = getAllSourceFiles(db);
      depBoostMap = computeDependencyBoost(sourceFiles, codePath);
    } catch {
      // Graceful fallback — dependency ordering is optional
    }
  }

  // Build file-level symbol count map from fileCoverage
  const fileSymbolCounts = new Map<string, number>();
  for (const fc of fileCoverage) {
    fileSymbolCounts.set(fc.file_path, fc.symbol_count);
  }

  // Group uncovered symbols by file
  const byFile = new Map<string, Array<{ name: string; kind: SymbolKind }>>();
  for (const sym of uncovered) {
    let list = byFile.get(sym.file_path);
    if (!list) {
      list = [];
      byFile.set(sym.file_path, list);
    }
    list.push({ name: sym.name, kind: sym.kind });
  }

  // Group files by directory prefix
  const byDir = new Map<string, FileGroup[]>();
  for (const [filePath, symbols] of byFile) {
    const dir = directoryPrefix(filePath);
    let files = byDir.get(dir);
    if (!files) {
      files = [];
      byDir.set(dir, files);
    }
    files.push({ file_path: filePath, symbols });
  }

  // Build DirGroups and score
  const groups: DirGroup[] = [];
  for (const [directory, files] of byDir) {
    const totalUncovered = files.reduce((acc, f) => acc + f.symbols.length, 0);
    const group: DirGroup = { directory, files, totalUncovered, score: 0 };
    const boost = depBoostMap?.get(directory);
    group.score = scoreGroup(group, boost);
    groups.push(group);
  }

  // Sort by score descending
  groups.sort((a, b) => b.score - a.score);

  // Build phases
  const phases: BootstrapPhase[] = groups.map((group, index) => ({
    name: `Phase ${index + 1}: ${group.directory}`,
    directory: group.directory,
    files: group.files
      .sort((a, b) => b.symbols.length - a.symbols.length)
      .map((f) => ({
        file_path: f.file_path,
        uncovered_count: f.symbols.length,
        total_exported: fileSymbolCounts.get(f.file_path) ?? f.symbols.length,
        symbols: f.symbols.slice(0, 8),
      })),
    total_symbols: group.totalUncovered,
    rationale: phaseRationale(group, index, depBoostMap?.get(group.directory)),
  }));

  // Incremental progress: dirs with exported symbols that have NO uncovered symbols
  const uncoveredDirs = new Set(groups.map((g) => g.directory));
  const phasesComplete = allExportedDirs.size - uncoveredDirs.size;
  const coverageRatio = stats.total_exported > 0 ? stats.bound_exported / stats.total_exported : 0;

  return {
    phases,
    progress: {
      total_exported: stats.total_exported,
      covered_exported: stats.bound_exported,
      coverage_ratio: coverageRatio,
      phases_complete: Math.max(0, phasesComplete),
      phases_total: allExportedDirs.size,
    },
    computed_at: now,
  };
}
