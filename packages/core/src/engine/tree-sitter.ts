import { readFileSync } from "fs";
import type { SupportedLanguage } from "@/types/index.ts";

// ─── Minimal type shims for web-tree-sitter v0.26 ──────────
// We define our own types instead of relying on the package's .d.ts
// to insulate the rest of the codebase from WASM module quirks.

export type TreeSitterParser = {
  setLanguage(lang: TreeSitterLanguage): void;
  parse(input: string): TreeSitterTree;
  delete(): void;
};

export type TreeSitterLanguage = {
  // In v0.26, query() moved to the standalone Query class.
  // Language is opaque — used only to load grammars and construct queries.
  // It has no delete(): web-tree-sitter gives no way to free a grammar, which
  // is why the pool below is shared instead of built per scan.
};

export type TreeSitterQuery = {
  matches(node: TreeSitterNode): TreeSitterMatch[];
  delete(): void;
};

type TreeSitterMatch = {
  pattern: number;
  captures: TreeSitterCapture[];
};

type TreeSitterCapture = {
  name: string;
  node: TreeSitterNode;
};

export type TreeSitterTree = {
  rootNode: TreeSitterNode;
  delete(): void;
};

export type TreeSitterNode = {
  type: string;
  text: string;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  parent: TreeSitterNode | null;
  children: TreeSitterNode[];
  childForFieldName(name: string): TreeSitterNode | null;
  namedChildren: TreeSitterNode[];
};

// ─── Internal module-level typing for the dynamic import ────

interface WTSModule {
  Parser: {
    init(opts?: { wasmBinary?: Uint8Array }): Promise<void>;
    new (): TreeSitterParser;
  };
  Language: {
    load(wasmBuf: Uint8Array): Promise<TreeSitterLanguage>;
  };
  Query: {
    new (lang: TreeSitterLanguage, source: string): TreeSitterQuery;
  };
}

// ─── Constants ──────────────────────────────────────────────

// A `type: "file"` import gives back a path. `bun build --compile` embeds the
// file and rewrites the path. The binary then reads its grammars from itself.
// A source checkout gets the path in node_modules.
//
// `require.resolve` cannot do this. `bun build --compile` writes the build
// machine's absolute path into the binary. That path is gone on other machines.
//
// The imports are dynamic, and they stay inside loadLanguage. A static import
// runs when this module loads, and @lore/core loads it for every command. One
// unresolvable grammar would then stop commands that need no grammar at all.
type GrammarLoader = () => Promise<{ default: string }>;

/** A grammar could not be read or instantiated. Distinct from a parse failure:
 *  it condemns every file of that language, not the one being scanned, so
 *  callers surface it instead of counting the file as failed. */
export class GrammarLoadError extends Error {
  constructor(language: string, cause: unknown) {
    super(`Cannot load the ${language} grammar: ${String(cause)}`, { cause });
    this.name = "GrammarLoadError";
  }
}

const RUNTIME_WASM: GrammarLoader = () =>
  import("web-tree-sitter/web-tree-sitter.wasm", { with: { type: "file" } });

// @repomix/tree-sitter-wasms ships prebuilt grammars for five of these
// languages. tree-sitter-elixir ships its own.
//
// Lean has neither. Its grammar is a GitHub repository with no npm release, so
// lore carries the built wasm in packages/core/grammars. Rebuild it with
// scripts/build-lean-grammar.sh, which pins the grammar commit.
const LANGUAGE_WASM_MAP: Record<SupportedLanguage, GrammarLoader> = {
  typescript: () =>
    import("@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm", {
      with: { type: "file" },
    }),
  javascript: () =>
    import("@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm", {
      with: { type: "file" },
    }),
  python: () =>
    import("@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm", { with: { type: "file" } }),
  go: () =>
    import("@repomix/tree-sitter-wasms/out/tree-sitter-go.wasm", { with: { type: "file" } }),
  rust: () =>
    import("@repomix/tree-sitter-wasms/out/tree-sitter-rust.wasm", { with: { type: "file" } }),
  elixir: () => import("tree-sitter-elixir/tree-sitter-elixir.wasm", { with: { type: "file" } }),
  lean: () => import("../../grammars/tree-sitter-lean.wasm", { with: { type: "file" } }),
};

const TSX_WASM: GrammarLoader = () =>
  import("@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm", { with: { type: "file" } });

// ─── Pool ───────────────────────────────────────────────────

export class TreeSitterPool {
  private wts: WTSModule | null = null;
  // Each entry holds the in-flight load, not the finished Language. Storing the
  // finished object leaves a window between the cache miss and the write in
  // which every concurrent caller loads its own copy of the grammar, and all
  // but the last are dropped without delete().
  private languages: Map<string, Promise<TreeSitterLanguage>> = new Map();
  private starting: Promise<void> | null = null;

  async init(): Promise<void> {
    // The guard must be the promise, not `this.wts`. web-tree-sitter memoizes
    // its module with an assignment that runs after its own await, so two pools
    // that both pass a `this.wts` check build two wasm heaps, and grammars
    // loaded against the losing heap read foreign memory.
    const starting = (this.starting ??= this.start());
    // Drop a rejected attempt. Keeping it makes one transient failure permanent.
    starting.catch(() => {
      if (this.starting === starting) this.starting = null;
    });
    await starting;
  }

  private async start(): Promise<void> {
    const mod = (await import("web-tree-sitter")) as unknown as WTSModule;
    const { default: runtimeWasm } = await RUNTIME_WASM();
    // Bun needs wasmBinary (file:// URLs don't work reliably)
    const wasmBuf = readFileSync(runtimeWasm);
    await mod.Parser.init({ wasmBinary: new Uint8Array(wasmBuf) });

    this.wts = mod;
  }

  async loadLanguage(language: SupportedLanguage, isTsx?: boolean): Promise<TreeSitterLanguage> {
    const loadWasm = isTsx ? TSX_WASM : LANGUAGE_WASM_MAP[language];
    if (!loadWasm) throw new Error(`Unsupported language: ${language}`);

    const cacheKey = isTsx ? "tsx" : language;
    const cached = this.languages.get(cacheKey);
    if (cached) return cached;

    if (!this.wts) throw new Error("TreeSitterPool not initialized. Call init() first.");

    const pending = this.loadGrammar(loadWasm, cacheKey);
    this.languages.set(cacheKey, pending);
    // Evict a rejected load so a transient failure is not permanent, but only
    // while the entry is still this promise: a retry may already have replaced
    // it. The handler also keeps the rejection from going unobserved.
    pending.catch(() => {
      if (this.languages.get(cacheKey) === pending) this.languages.delete(cacheKey);
    });
    return pending;
  }

  private async loadGrammar(
    loadWasm: GrammarLoader,
    cacheKey: string,
  ): Promise<TreeSitterLanguage> {
    try {
      const { default: wasmPath } = await loadWasm();
      const wasmBuf = readFileSync(wasmPath);
      return await this.wts!.Language.load(new Uint8Array(wasmBuf));
    } catch (error) {
      throw new GrammarLoadError(cacheKey, error);
    }
  }

  createParser(): TreeSitterParser {
    if (!this.wts) throw new Error("TreeSitterPool not initialized. Call init() first.");
    return new this.wts.Parser();
  }

  createQuery(lang: TreeSitterLanguage, source: string): TreeSitterQuery {
    if (!this.wts) throw new Error("TreeSitterPool not initialized. Call init() first.");
    return new this.wts.Query(lang, source);
  }

  async parse(
    sourceCode: string,
    language: SupportedLanguage,
    isTsx?: boolean,
  ): Promise<{ tree: TreeSitterTree; lang: TreeSitterLanguage }> {
    const lang = await this.loadLanguage(language, isTsx);
    const parser = this.createParser();
    try {
      parser.setLanguage(lang);
      const tree = parser.parse(sourceCode);
      return { tree, lang };
    } finally {
      // A throw from setLanguage or parse would otherwise leak the parser's
      // wasm allocation, once per failing file.
      parser.delete();
    }
  }
}

// ─── Shared pool ────────────────────────────────────────────

/** The pool every scan uses. web-tree-sitter offers no way to free a grammar —
 *  Language has no delete — so a pool per scan would load the same grammars
 *  again on every close and every heal and grow the wasm heap without bound.
 *  One pool loads each grammar once and holds at most eight for the process.
 *  Parsers, trees and queries stay per-call, so concurrent scans do not share
 *  mutable state. */
let sharedPool: TreeSitterPool | null = null;

export async function getTreeSitterPool(): Promise<TreeSitterPool> {
  sharedPool ??= new TreeSitterPool();
  await sharedPool.init();
  return sharedPool;
}
