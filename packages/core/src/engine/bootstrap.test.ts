import { test, expect, describe } from "bun:test";
import { createTestDb, createTempDir, removeDir } from "../../test/support/db.ts";
import {
  computeBootstrapPlan,
  extractRelativeImports,
  resolveImportPath,
  resolvePythonImportPath,
  computeDependencyBoost,
} from "./bootstrap.ts";
import { insertSourceFile } from "@/db/source-files.ts";
import { insertSymbol } from "@/db/symbols.ts";
import { upsertConceptSymbol } from "@/db/concept-symbols.ts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";

function addConcept(db: ReturnType<typeof createTestDb>, name: string): string {
  const id = ulid();
  const versionId = ulid();
  const now = new Date().toISOString();
  db.run(`INSERT INTO concepts (version_id, id, name, inserted_at) VALUES (?, ?, ?, ?)`, [
    versionId,
    id,
    name,
    now,
  ]);
  return id;
}

function addFile(
  db: ReturnType<typeof createTestDb>,
  filePath: string,
  symbolCount: number,
  language: "typescript" | "javascript" | "python" | "go" | "rust" = "typescript",
) {
  return insertSourceFile(db, {
    filePath,
    language,
    contentHash: `hash-${filePath}`,
    sizeBytes: 1000,
    symbolCount,
  });
}

function addSymbol(
  db: ReturnType<typeof createTestDb>,
  sourceFileId: string,
  name: string,
  kind: "function" | "interface" | "type" | "class" | "enum" | "method",
  exported: boolean,
) {
  return insertSymbol(db, {
    sourceFileId,
    name,
    qualifiedName: name,
    kind,
    parentId: null,
    lineStart: 1,
    lineEnd: 10,
    signature: null,
    bodyHash: null,
    exportStatus: exported ? "exported" : "local",
  });
}

test("empty DB returns empty plan", () => {
  const db = createTestDb();
  const plan = computeBootstrapPlan(db);

  expect(plan.phases).toHaveLength(0);
  expect(plan.progress.total_exported).toBe(0);
  expect(plan.progress.covered_exported).toBe(0);
  expect(plan.progress.phases_complete).toBe(0);
  expect(plan.progress.phases_total).toBe(0);

  db.close();
});

test("fully covered codebase returns empty phases", () => {
  const db = createTestDb();

  // Add a file with symbols but no uncovered exported ones
  const sf = addFile(db, "src/utils.ts", 2);
  addSymbol(db, sf.id, "helper", "function", false); // local, not exported

  const plan = computeBootstrapPlan(db);
  expect(plan.phases).toHaveLength(0);

  db.close();
});

test("groups uncovered symbols by directory and orders shallow first", () => {
  const db = createTestDb();

  // Shallow directory with types (should be Phase 1)
  const sf1 = addFile(db, "src/types/index.ts", 4);
  addSymbol(db, sf1.id, "UserConfig", "interface", true);
  addSymbol(db, sf1.id, "AppSettings", "type", true);
  addSymbol(db, sf1.id, "StatusEnum", "enum", true);
  addSymbol(db, sf1.id, "InternalHelper", "function", false); // local, should not appear

  // Deeper directory with functions (should be Phase 2)
  const sf2 = addFile(db, "src/services/auth/login.ts", 3);
  addSymbol(db, sf2.id, "authenticate", "function", true);
  addSymbol(db, sf2.id, "validateToken", "function", true);
  addSymbol(db, sf2.id, "refreshSession", "function", true);

  // Another shallow dir with one symbol in same group as sf1
  const sf3 = addFile(db, "src/types/errors.ts", 2);
  addSymbol(db, sf3.id, "LoreError", "class", true);
  addSymbol(db, sf3.id, "ErrorCode", "enum", true);

  const plan = computeBootstrapPlan(db);

  // Should have 2 phases: src/types and src/services
  expect(plan.phases).toHaveLength(2);

  // Phase 1 should be src/types (shallow + type-heavy)
  expect(plan.phases[0]!.directory).toBe("src/types");
  expect(plan.phases[0]!.name).toStartWith("Phase 1:");
  expect(plan.phases[0]!.total_symbols).toBe(5); // 3 from index.ts + 2 from errors.ts
  expect(plan.phases[0]!.files).toHaveLength(2);
  expect(plan.phases[0]!.rationale).toContain("Start here:");

  // Phase 2 should be src/services
  expect(plan.phases[1]!.directory).toBe("src/services");
  expect(plan.phases[1]!.name).toStartWith("Phase 2:");
  expect(plan.phases[1]!.total_symbols).toBe(3);

  // Progress
  expect(plan.progress.total_exported).toBe(8);
  expect(plan.progress.covered_exported).toBe(0);
  expect(plan.progress.phases_complete).toBe(0);
  expect(plan.progress.phases_total).toBe(2);

  db.close();
});

test("files within a phase are sorted by uncovered count descending", () => {
  const db = createTestDb();

  const sf1 = addFile(db, "src/core/small.ts", 1);
  addSymbol(db, sf1.id, "smallFn", "function", true);

  const sf2 = addFile(db, "src/core/big.ts", 3);
  addSymbol(db, sf2.id, "bigFn1", "function", true);
  addSymbol(db, sf2.id, "bigFn2", "function", true);
  addSymbol(db, sf2.id, "bigFn3", "function", true);

  const plan = computeBootstrapPlan(db);
  expect(plan.phases).toHaveLength(1);

  const phase = plan.phases[0]!;
  expect(phase.files[0]!.file_path).toBe("src/core/big.ts");
  expect(phase.files[1]!.file_path).toBe("src/core/small.ts");

  db.close();
});

test("symbols list is capped at 8 per file", () => {
  const db = createTestDb();

  const sf = addFile(db, "src/api/routes.ts", 12);
  for (let i = 0; i < 12; i++) {
    addSymbol(db, sf.id, `route${i}`, "function", true);
  }

  const plan = computeBootstrapPlan(db);
  const file = plan.phases[0]!.files[0]!;
  expect(file.symbols).toHaveLength(8);
  expect(file.uncovered_count).toBe(12);

  db.close();
});

// ─── extractRelativeImports ────────────────────────────────

describe("extractRelativeImports", () => {
  test("extracts relative imports from TypeScript", () => {
    const content = `
import { Foo } from './types';
import { Bar } from '../utils/bar';
import { Baz } from '@/external/baz';
export { Qux } from './qux';
`;
    const result = extractRelativeImports(content, "typescript");
    expect(result).toEqual(["./types", "../utils/bar", "./qux"]);
  });

  test("ignores non-relative imports", () => {
    const content = `import { readFileSync } from "node:fs";\nimport express from "express";`;
    expect(extractRelativeImports(content, "typescript")).toEqual([]);
  });

  test("returns empty for unsupported languages", () => {
    const content = `import { Foo } from './types';`;
    expect(extractRelativeImports(content, "rust")).toEqual([]);
    expect(extractRelativeImports(content, "go")).toEqual([]);
  });

  test("handles JavaScript language", () => {
    const content = `import { Foo } from './types';`;
    expect(extractRelativeImports(content, "javascript")).toEqual(["./types"]);
  });
});

// ─── resolveImportPath ─────────────────────────────────────

describe("resolveImportPath", () => {
  test("resolves sibling import", () => {
    expect(resolveImportPath("src/types/index.ts", "./utils")).toBe("src/types/utils");
  });

  test("resolves parent import", () => {
    expect(resolveImportPath("src/services/auth/login.ts", "../types")).toBe("src/services/types");
  });

  test("resolves double parent import", () => {
    expect(resolveImportPath("src/services/auth/login.ts", "../../types")).toBe("src/types");
  });

  test("resolves current-dir import", () => {
    expect(resolveImportPath("src/index.ts", "./utils")).toBe("src/utils");
  });

  test("returns null for empty resolution", () => {
    expect(resolveImportPath("index.ts", "..")).toBeNull();
  });
});

// ─── computeDependencyBoost ────────────────────────────────

describe("computeDependencyBoost", () => {
  test("builds directory dependency counts from imports", () => {
    const tmpDir = createTempDir("bootstrap-dep-");
    try {
      // Create source structure:
      // src/types/index.ts — no imports (foundational)
      // src/services/auth.ts — imports from ../types
      // src/api/routes.ts — imports from ../types and ../services
      mkdirSync(join(tmpDir, "src/types"), { recursive: true });
      mkdirSync(join(tmpDir, "src/services"), { recursive: true });
      mkdirSync(join(tmpDir, "src/api"), { recursive: true });

      writeFileSync(
        join(tmpDir, "src/types/index.ts"),
        `export interface User { id: string; }\nexport type Config = { key: string; };\n`,
      );
      writeFileSync(
        join(tmpDir, "src/services/auth.ts"),
        `import { User } from '../types/index';\nexport function authenticate(u: User) {}\n`,
      );
      writeFileSync(
        join(tmpDir, "src/api/routes.ts"),
        `import { authenticate } from '../services/auth';\nimport { Config } from '../types/index';\nexport function setup(c: Config) { authenticate({id:'1'}); }\n`,
      );

      const sourceFiles = [
        { file_path: "src/types/index.ts" },
        { file_path: "src/services/auth.ts" },
        { file_path: "src/api/routes.ts" },
      ];

      const boost = computeDependencyBoost(sourceFiles, tmpDir);

      // src/types is imported by src/services and src/api → boost 2
      expect(boost.get("src/types")).toBe(2);
      // src/services is imported by src/api → boost 1
      expect(boost.get("src/services")).toBe(1);
      // src/api has no dependents
      expect(boost.has("src/api")).toBe(false);
    } finally {
      removeDir(tmpDir);
    }
  });

  test("skips intra-directory imports", () => {
    const tmpDir = createTempDir("bootstrap-dep-");
    try {
      mkdirSync(join(tmpDir, "src/utils"), { recursive: true });
      writeFileSync(join(tmpDir, "src/utils/a.ts"), `import { b } from './b';\n`);
      writeFileSync(join(tmpDir, "src/utils/b.ts"), `export const b = 1;\n`);

      const sourceFiles = [{ file_path: "src/utils/a.ts" }, { file_path: "src/utils/b.ts" }];
      const boost = computeDependencyBoost(sourceFiles, tmpDir);
      // Same directory — no boost
      expect(boost.size).toBe(0);
    } finally {
      removeDir(tmpDir);
    }
  });

  test("handles missing files gracefully", () => {
    const boost = computeDependencyBoost(
      [{ file_path: "nonexistent/file.ts" }],
      "/tmp/no-such-dir",
    );
    expect(boost.size).toBe(0);
  });
});

// ─── Incremental progress ──────────────────────────────────

describe("incremental progress", () => {
  test("phases_complete reflects fully-covered directory groups", () => {
    const db = createTestDb();

    // Dir 1: src/types — fully covered (all symbols bound)
    const sf1 = addFile(db, "src/types/index.ts", 2);
    const sym1 = addSymbol(db, sf1.id, "UserConfig", "interface", true);
    // Create a concept and bind the symbol
    const conceptId = addConcept(db, "test-concept");
    upsertConceptSymbol(db, {
      conceptId,
      symbolId: sym1.id,
      bindingType: "ref",
      boundBodyHash: null,
      confidence: 1.0,
    });

    // Dir 2: src/services — uncovered
    const sf2 = addFile(db, "src/services/auth.ts", 2);
    addSymbol(db, sf2.id, "authenticate", "function", true);

    const plan = computeBootstrapPlan(db);

    // 1 phase remaining (src/services uncovered), 1 complete (src/types)
    expect(plan.phases).toHaveLength(1);
    expect(plan.phases[0]!.directory).toBe("src/services");
    expect(plan.progress.phases_complete).toBe(1);
    expect(plan.progress.phases_total).toBe(2);

    db.close();
  });

  test("all dirs covered yields phases_complete == phases_total with empty phases", () => {
    const db = createTestDb();

    const sf = addFile(db, "src/types/index.ts", 1);
    const sym = addSymbol(db, sf.id, "UserConfig", "interface", true);

    const conceptId = addConcept(db, "test-concept");
    upsertConceptSymbol(db, {
      conceptId,
      symbolId: sym.id,
      bindingType: "ref",
      boundBodyHash: null,
      confidence: 1.0,
    });

    const plan = computeBootstrapPlan(db);
    expect(plan.phases).toHaveLength(0);
    expect(plan.progress.phases_complete).toBe(1);
    expect(plan.progress.phases_total).toBe(1);

    db.close();
  });
});

// ─── Dependency ordering in bootstrap plan ─────────────────

describe("dependency ordering", () => {
  test("directories imported by more others rank higher", () => {
    const tmpDir = createTempDir("bootstrap-order-");
    const db = createTestDb();
    try {
      // Setup: src/types imported by src/services and src/api
      // Without dependency boost, src/services might rank equal or higher due to count
      mkdirSync(join(tmpDir, "src/types"), { recursive: true });
      mkdirSync(join(tmpDir, "src/services"), { recursive: true });
      mkdirSync(join(tmpDir, "src/api"), { recursive: true });

      writeFileSync(join(tmpDir, "src/types/index.ts"), `export type Foo = string;\n`);
      writeFileSync(
        join(tmpDir, "src/services/auth.ts"),
        `import { Foo } from '../types/index';\nexport function auth(f: Foo) {}\nexport function validate() {}\nexport function refresh() {}\nexport function logout() {}\n`,
      );
      writeFileSync(
        join(tmpDir, "src/api/routes.ts"),
        `import { Foo } from '../types/index';\nimport { auth } from '../services/auth';\nexport function setup() {}\n`,
      );

      // Register source files in DB
      const sf1 = addFile(db, "src/types/index.ts", 1);
      addSymbol(db, sf1.id, "Foo", "type", true);

      const sf2 = addFile(db, "src/services/auth.ts", 4);
      addSymbol(db, sf2.id, "auth", "function", true);
      addSymbol(db, sf2.id, "validate", "function", true);
      addSymbol(db, sf2.id, "refresh", "function", true);
      addSymbol(db, sf2.id, "logout", "function", true);

      const sf3 = addFile(db, "src/api/routes.ts", 1);
      addSymbol(db, sf3.id, "setup", "function", true);

      const plan = computeBootstrapPlan(db, tmpDir);

      // src/types should be Phase 1 (imported by 2 dirs → +400 boost)
      expect(plan.phases[0]!.directory).toBe("src/types");
      expect(plan.phases[0]!.rationale).toContain("imported by 2 other directories");
    } finally {
      db.close();
      removeDir(tmpDir);
    }
  });
});

// ─── Python import support ────────────────────────────────

describe("extractRelativeImports (Python)", () => {
  test("extracts relative imports from Python", () => {
    const content = `
from .utils import helper
from ..config import settings
from ...core.db import connect
import os
from external_lib import something
`;
    const result = extractRelativeImports(content, "python");
    expect(result).toEqual([".utils", "..config", "...core.db"]);
  });

  test("handles single-dot import", () => {
    const content = `from . import models`;
    const result = extractRelativeImports(content, "python");
    expect(result).toEqual(["."]);
  });

  test("ignores absolute imports", () => {
    const content = `from django.db import models\nimport json`;
    expect(extractRelativeImports(content, "python")).toEqual([]);
  });
});

describe("resolvePythonImportPath", () => {
  test("resolves single-dot import", () => {
    expect(resolvePythonImportPath("src/services/auth.py", ".utils")).toBe("src/services/utils");
  });

  test("resolves double-dot import", () => {
    expect(resolvePythonImportPath("src/services/auth.py", "..config")).toBe("src/config");
  });

  test("resolves triple-dot import", () => {
    expect(resolvePythonImportPath("src/services/sub/auth.py", "...types")).toBe("src/types");
  });

  test("resolves dotted module path", () => {
    expect(resolvePythonImportPath("src/services/auth.py", "..core.db")).toBe("src/core/db");
  });

  test("resolves bare dot import (from . import x)", () => {
    expect(resolvePythonImportPath("src/services/auth.py", ".")).toBe("src/services");
  });
});

describe("Python dependency ordering", () => {
  test("Python directories with relative imports get dependency boost", () => {
    const tmpDir = createTempDir("bootstrap-py-");
    const db = createTestDb();
    try {
      mkdirSync(join(tmpDir, "src/models"), { recursive: true });
      mkdirSync(join(tmpDir, "src/services"), { recursive: true });
      mkdirSync(join(tmpDir, "src/api"), { recursive: true });

      writeFileSync(join(tmpDir, "src/models/user.py"), `class User:\n    pass\n`);
      writeFileSync(
        join(tmpDir, "src/services/auth.py"),
        `from ..models.user import User\n\ndef authenticate(u: User):\n    pass\n`,
      );
      writeFileSync(
        join(tmpDir, "src/api/routes.py"),
        `from ..models.user import User\nfrom ..services.auth import authenticate\n`,
      );

      const sourceFiles = [
        { file_path: "src/models/user.py" },
        { file_path: "src/services/auth.py" },
        { file_path: "src/api/routes.py" },
      ];

      const boost = computeDependencyBoost(sourceFiles, tmpDir);

      // src/models is imported by src/services and src/api → boost 2
      expect(boost.get("src/models")).toBe(2);
      // src/services is imported by src/api → boost 1
      expect(boost.get("src/services")).toBe(1);
      // src/api has no dependents
      expect(boost.has("src/api")).toBe(false);
    } finally {
      db.close();
      removeDir(tmpDir);
    }
  });

  test("Python files in bootstrap plan get ranked with dependency boost", () => {
    const tmpDir = createTempDir("bootstrap-py-plan-");
    const db = createTestDb();
    try {
      mkdirSync(join(tmpDir, "src/models"), { recursive: true });
      mkdirSync(join(tmpDir, "src/api"), { recursive: true });

      writeFileSync(join(tmpDir, "src/models/user.py"), `class User:\n    pass\n`);
      writeFileSync(join(tmpDir, "src/api/routes.py"), `from ..models.user import User\n`);

      // Register files in DB
      const sf1 = addFile(db, "src/models/user.py", 1, "python");
      addSymbol(db, sf1.id, "User", "class", true);

      const sf2 = addFile(db, "src/api/routes.py", 1, "python");
      addSymbol(db, sf2.id, "routes", "function", true);

      const plan = computeBootstrapPlan(db, tmpDir);

      // src/models should be Phase 1 (imported by src/api)
      expect(plan.phases[0]!.directory).toBe("src/models");
      expect(plan.phases[0]!.rationale).toContain("imported by 1 other directories");
    } finally {
      db.close();
      removeDir(tmpDir);
    }
  });
});
