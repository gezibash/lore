import { readFileSync } from "fs";
import { dirname, join } from "path";
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
};

export type TreeSitterQuery = {
  matches(node: TreeSitterNode): TreeSitterMatch[];
  delete(): void;
};

export type TreeSitterMatch = {
  pattern: number;
  captures: TreeSitterCapture[];
};

export type TreeSitterCapture = {
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

// Languages available in @repomix/tree-sitter-wasms
const LANGUAGE_WASM_MAP: Partial<Record<SupportedLanguage, string>> = {
  typescript: "tree-sitter-typescript.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
};

// Languages only available in tree-sitter-wasms (fallback package)
const SECONDARY_LANGUAGE_WASM_MAP: Partial<Record<SupportedLanguage, string>> = {
  elixir: "tree-sitter-elixir.wasm",
};

const TSX_WASM = "tree-sitter-tsx.wasm";

// ─── Pool ───────────────────────────────────────────────────

export class TreeSitterPool {
  private wts: WTSModule | null = null;
  private languages: Map<string, TreeSitterLanguage> = new Map();
  private wasmsDir: string = "";
  private secondaryWasmsDir: string = "";

  async init(): Promise<void> {
    if (this.wts) return;

    const mod = (await import("web-tree-sitter")) as unknown as WTSModule;
    const wtsDir = dirname(require.resolve("web-tree-sitter/package.json"));
    this.wasmsDir = join(
      dirname(require.resolve("@repomix/tree-sitter-wasms/package.json")),
      "out",
    );
    this.secondaryWasmsDir = join(
      dirname(require.resolve("tree-sitter-wasms/package.json")),
      "out",
    );

    // Bun needs wasmBinary (file:// URLs don't work reliably)
    const wasmBuf = readFileSync(join(wtsDir, "web-tree-sitter.wasm"));
    await mod.Parser.init({ wasmBinary: new Uint8Array(wasmBuf) });

    this.wts = mod;
  }

  async loadLanguage(language: SupportedLanguage, isTsx?: boolean): Promise<TreeSitterLanguage> {
    const primaryWasm = isTsx ? TSX_WASM : LANGUAGE_WASM_MAP[language];
    const secondaryWasm = !isTsx ? SECONDARY_LANGUAGE_WASM_MAP[language] : undefined;
    const wasmFile = primaryWasm ?? secondaryWasm;
    const wasmDir = primaryWasm ? this.wasmsDir : this.secondaryWasmsDir;
    if (!wasmFile) throw new Error(`Unsupported language: ${language}`);

    const cacheKey = isTsx ? "tsx" : language;
    const cached = this.languages.get(cacheKey);
    if (cached) return cached;

    if (!this.wts) throw new Error("TreeSitterPool not initialized. Call init() first.");

    const wasmPath = join(wasmDir, wasmFile);
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
