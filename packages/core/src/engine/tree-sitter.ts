import { readFileSync } from "fs";
import type { SupportedLanguage } from "@/types/index.ts";

// Every wasm travels inside the executable. `bun build --compile` bakes a
// `type: "file"` import into the bundle and rewrites the specifier to the
// embedded copy, so the binary reads its grammars from itself. Resolution
// through node_modules cannot do this: the bundler writes the build machine's
// absolute path into the binary, and that path is gone on any other machine.
import runtimeWasm from "web-tree-sitter/web-tree-sitter.wasm" with { type: "file" };
import typescriptWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-typescript.wasm" with { type: "file" };
import tsxWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-tsx.wasm" with { type: "file" };
import javascriptWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-javascript.wasm" with { type: "file" };
import pythonWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-python.wasm" with { type: "file" };
import goWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-go.wasm" with { type: "file" };
import rustWasm from "@repomix/tree-sitter-wasms/out/tree-sitter-rust.wasm" with { type: "file" };
// @repomix/tree-sitter-wasms ships 17 grammars, and Elixir is not one of them.
// tree-sitter-elixir ships its own prebuilt wasm.
import elixirWasm from "tree-sitter-elixir/tree-sitter-elixir.wasm" with { type: "file" };

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

const LANGUAGE_WASM_MAP: Record<SupportedLanguage, string> = {
  typescript: typescriptWasm,
  javascript: javascriptWasm,
  python: pythonWasm,
  go: goWasm,
  rust: rustWasm,
  elixir: elixirWasm,
};

const TSX_WASM = tsxWasm;

// ─── Pool ───────────────────────────────────────────────────

export class TreeSitterPool {
  private wts: WTSModule | null = null;
  private languages: Map<string, TreeSitterLanguage> = new Map();

  async init(): Promise<void> {
    if (this.wts) return;

    const mod = (await import("web-tree-sitter")) as unknown as WTSModule;
    // Bun needs wasmBinary (file:// URLs don't work reliably)
    const wasmBuf = readFileSync(runtimeWasm);
    await mod.Parser.init({ wasmBinary: new Uint8Array(wasmBuf) });

    this.wts = mod;
  }

  async loadLanguage(language: SupportedLanguage, isTsx?: boolean): Promise<TreeSitterLanguage> {
    const wasmPath = isTsx ? TSX_WASM : LANGUAGE_WASM_MAP[language];
    if (!wasmPath) throw new Error(`Unsupported language: ${language}`);

    const cacheKey = isTsx ? "tsx" : language;
    const cached = this.languages.get(cacheKey);
    if (cached) return cached;

    if (!this.wts) throw new Error("TreeSitterPool not initialized. Call init() first.");

    const wasmBuf = readFileSync(wasmPath);
    const lang = await this.wts.Language.load(new Uint8Array(wasmBuf));
    this.languages.set(cacheKey, lang);
    return lang;
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
    parser.setLanguage(lang);
    const tree = parser.parse(sourceCode);
    parser.delete();
    return { tree, lang };
  }
}
