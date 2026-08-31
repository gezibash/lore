import { createHash } from "crypto";
import type {
  SupportedLanguage,
  SymbolKind,
  ExtractedSymbol,
  ExtractedCallSite,
} from "@/types/index.ts";
import type {
  TreeSitterLanguage,
  TreeSitterTree,
  TreeSitterNode,
  TreeSitterQuery,
} from "./tree-sitter.ts";
import type { TreeSitterPool } from "./tree-sitter.ts";

// ─── Per-Language S-Expression Queries ─────────────────────

const TYPESCRIPT_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (type_identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(interface_declaration name: (type_identifier) @name) @definition.interface
(type_alias_declaration name: (type_identifier) @name) @definition.type
(enum_declaration name: (identifier) @name) @definition.enum
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
(program
  (lexical_declaration
    (variable_declarator name: (identifier) @name)) @definition.constant)
(program
  (export_statement
    (lexical_declaration
      (variable_declarator name: (identifier) @name)) @definition.constant))
`;

const JAVASCRIPT_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
(program
  (lexical_declaration
    (variable_declarator name: (identifier) @name)) @definition.constant)
`;

const PYTHON_QUERY = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
(module
  (expression_statement
    (assignment left: (identifier) @name)) @definition.constant)
`;

const GO_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(method_declaration name: (field_identifier) @name) @definition.method
(type_declaration (type_spec name: (type_identifier) @name (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name (interface_type))) @definition.interface
`;

const RUST_QUERY = `
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name) @definition.impl
`;

// def/defp/defmacro/defmacrop — function definitions
// defmodule — module (treated as class)
// defprotocol — protocol (treated as interface)
// Two forms per def:
//   with parens:  def foo(args) do   → arguments contains a call node
//   without parens: def foo do       → arguments contains a bare identifier
const ELIXIR_QUERY = `
(call
  target: (identifier) @_kw
  (arguments (call target: (identifier) @name))
  (#match? @_kw "^defp?$")) @definition.function
(call
  target: (identifier) @_kw
  (arguments (identifier) @name)
  (#match? @_kw "^defp?$")) @definition.function
(call
  target: (identifier) @_kw
  (arguments (binary_operator left: (call target: (identifier) @name) operator: "when"))
  (#match? @_kw "^defp?$")) @definition.function
(call
  target: (identifier) @_kw
  (arguments (call target: (identifier) @name))
  (#match? @_kw "^defmacrop?$")) @definition.function
(call
  target: (identifier) @_kw
  (arguments (identifier) @name)
  (#match? @_kw "^defmacrop?$")) @definition.function
(call
  target: (identifier) @_kw
  (arguments (alias) @name)
  (#eq? @_kw "defmodule")) @definition.class
(call
  target: (identifier) @_kw
  (arguments (alias) @name)
  (#eq? @_kw "defprotocol")) @definition.interface
`;

const QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TYPESCRIPT_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  elixir: ELIXIR_QUERY,
};

// ─── Per-Language Call-Site Queries ───────────────────────

const TS_CALL_QUERY = `
(call_expression function: (identifier) @call.name) @call.site
(call_expression function: (member_expression property: (property_identifier) @call.name)) @call.site
`;

const PYTHON_CALL_QUERY = `
(call function: (identifier) @call.name) @call.site
(call function: (attribute attribute: (identifier) @call.name)) @call.site
`;

const GO_CALL_QUERY = `
(call_expression function: (identifier) @call.name) @call.site
(call_expression function: (selector_expression field: (field_identifier) @call.name)) @call.site
`;

const RUST_CALL_QUERY = `
(call_expression function: (identifier) @call.name) @call.site
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call.site
`;

// Elixir has no call syntax of its own: `def`, `defmodule`, `alias` and the
// module attributes are all `call` nodes. Without the filter they become the
// highest-degree callees in the graph, ahead of every real function.
//
// One list, read two ways. The query drops these names as callees, and
// isElixirDeclarationSite reads the same set to recognise a definition head.
// Two lists would drift, and the drift is silent: the graph just gains noise.
const ELIXIR_DEFINITION_FORMS = [
  "def",
  "defp",
  "defmacro",
  "defmacrop",
  "defmodule",
  "defprotocol",
  "defimpl",
  "defstruct",
  "defexception",
  "defdelegate",
  "defguard",
  "defguardp",
  "defoverridable",
];

/** Directives, not definitions: they take no head to skip, but they are calls
 *  in the tree and are not calls in the program. */
const ELIXIR_DIRECTIVES = ["alias", "import", "require", "use"];

/** Escape a literal for use inside the query's regex. The names are word
 *  characters today; a future entry with a metacharacter would otherwise build
 *  a pattern that silently matches the wrong set, or one that fails to compile
 *  and takes every Elixir call site with it. */
function escapeForRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ELIXIR_NON_CALLS = [...ELIXIR_DEFINITION_FORMS, ...ELIXIR_DIRECTIVES]
  .map(escapeForRegex)
  .join("|");

const ELIXIR_CALL_QUERY = `
(call target: (identifier) @call.name
  (#not-match? @call.name "^(${ELIXIR_NON_CALLS})$")) @call.site
(call target: (dot right: (identifier) @call.name)) @call.site
`;

const CALL_QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TS_CALL_QUERY,
  javascript: TS_CALL_QUERY,
  python: PYTHON_CALL_QUERY,
  go: GO_CALL_QUERY,
  rust: RUST_CALL_QUERY,
  elixir: ELIXIR_CALL_QUERY,
};

function nodeKindFromCapture(captureName: string): SymbolKind | null {
  const parts = captureName.split(".");
  if (parts.length < 2 || parts[0] !== "definition") return null;
  const kind = parts[1] as string;
  const valid: SymbolKind[] = [
    "function",
    "class",
    "method",
    "interface",
    "type",
    "enum",
    "struct",
    "trait",
    "impl",
    "constant",
  ];
  return valid.includes(kind as SymbolKind) ? (kind as SymbolKind) : null;
}

function extractSignature(
  node: TreeSitterNode,
  sourceLines: string[],
  language: SupportedLanguage,
): string | null {
  const startLine = node.startPosition.row;
  const endLine = Math.min(startLine + 2, node.endPosition.row);
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    if (i < sourceLines.length) {
      lines.push(sourceLines[i]!);
    }
  }
  let sig = lines.join("\n").trim();
  // Truncate at the start of the body. Elixir bodies open with `do`, and its
  // heads are full of `%Struct{}`, `%{}` and `{}` patterns, so cutting at `{`
  // there truncates the head mid-pattern: `def sign(%__MODULE__`.
  const bodyStart = language === "elixir" ? sig.search(/\bdo\b/) : sig.search(/\{|\bdo\b/);
  if (bodyStart > 0) {
    sig = sig.slice(0, bodyStart).trim();
  }
  if (sig.length > 500) {
    sig = sig.slice(0, 500) + "...";
  }
  return sig || null;
}

function computeBodyHash(node: TreeSitterNode): string | null {
  const text = node.text;
  if (!text || text.length === 0) return null;
  return createHash("sha256").update(text).digest("hex");
}

function detectExportStatus(
  node: TreeSitterNode,
  language: SupportedLanguage,
): "exported" | "default_export" | "local" | null {
  if (language === "elixir") {
    // def/defmacro are public; defp/defmacrop are private
    const target = node.childForFieldName("target");
    if (target?.text === "defp" || target?.text === "defmacrop") return "local";
    return "exported";
  }
  if (language === "python" || language === "go" || language === "rust") {
    // Python: all top-level are "exported" by convention
    // Go: capitalized names are exported
    // Rust: pub keyword
    if (language === "go") {
      const parent = node.parent;
      // If top-level and starts with capital, it's exported
      if (parent?.type === "source_file") {
        // Check the name child
        for (const child of node.namedChildren) {
          if (
            (child.type === "identifier" ||
              child.type === "type_identifier" ||
              child.type === "field_identifier") &&
            child.text.length > 0 &&
            child.text[0]! >= "A" &&
            child.text[0]! <= "Z"
          ) {
            return "exported";
          }
        }
        return "local";
      }
      return null;
    }
    if (language === "rust") {
      // Check if preceded by pub keyword
      const text = node.text;
      if (text.startsWith("pub ")) return "exported";
      return "local";
    }
    return null;
  }

  // TypeScript/JavaScript
  const parent = node.parent;
  if (!parent) return null;

  if (parent.type === "export_statement") {
    // Check for default export
    const text = parent.text;
    if (text.startsWith("export default")) return "default_export";
    return "exported";
  }

  return "local";
}

function findParentClass(node: TreeSitterNode, language: SupportedLanguage): string | null {
  // Elixir modules nest, and each level names only its own segment: `Helper`
  // inside `Arc.Storage` is `Arc.Storage.Helper`. Taking the nearest enclosing
  // module would store its functions as `Helper.run`, which matches no module
  // and collides with every other nested `Helper` in the project. Every other
  // language here has one meaningful container, so they keep the nearest.
  const elixirChain: string[] = [];
  let current = node.parent;
  while (current) {
    if (
      current.type === "class_declaration" ||
      current.type === "class_definition" ||
      current.type === "impl_item"
    ) {
      const nameNode =
        current.childForFieldName("name") ??
        current.namedChildren.find((c) => c.type === "type_identifier" || c.type === "identifier");
      if (nameNode) return nameNode.text;
    }
    // Elixir: defmodule/defprotocol call nodes.
    // tree-sitter-elixir only names the "target" field; arguments/do_block are
    // plain named children. Walk namedChildren to find the alias.
    if (current.type === "call") {
      const target = current.childForFieldName("target");
      if (target?.text === "defmodule" || target?.text === "defprotocol") {
        // Try: alias is a direct named child (e.g. defmodule Foo do)
        const directAlias = current.namedChildren.find((c) => c.type === "alias");
        // Try: alias inside an arguments node
        const argsNode = current.namedChildren.find((c) => c.type === "arguments");
        const alias =
          directAlias ?? argsNode?.namedChildren.find((c) => c.type === "alias") ?? null;
        if (alias) {
          if (language !== "elixir") return alias.text;
          elixirChain.unshift(alias.text);
        }
      }
    }
    current = current.parent;
  }
  return elixirChain.length > 0 ? elixirChain.join(".") : null;
}

export function extractSymbols(
  tree: TreeSitterTree,
  lang: TreeSitterLanguage,
  language: SupportedLanguage,
  sourceCode: string,
  pool: TreeSitterPool,
): ExtractedSymbol[] {
  const querySource = QUERY_MAP[language];
  if (!querySource) return [];

  const sourceLines = sourceCode.split("\n");

  let query;
  try {
    query = pool.createQuery(lang, querySource);
  } catch {
    // Query compilation failed for this grammar — skip
    return [];
  }

  // `const f = () => ...` matches both the function pattern and the constant
  // pattern, so it arrives twice. Keep one row per name and line, and prefer the
  // more specific kind: a constant capture never carries what the function
  // capture does.
  const byPosition = new Map<string, ExtractedSymbol>();

  try {
    collectSymbols(query, tree, language, sourceLines, byPosition);
  } finally {
    // A throw from matches() or a node accessor would otherwise leak the
    // compiled query, once per failing file.
    query.delete();
  }

  return [...byPosition.values()];
}

function collectSymbols(
  query: TreeSitterQuery,
  tree: TreeSitterTree,
  language: SupportedLanguage,
  sourceLines: string[],
  byPosition: Map<string, ExtractedSymbol>,
): void {
  const matches = query.matches(tree.rootNode);

  for (const match of matches) {
    let nameText: string | null = null;
    let definitionNode: TreeSitterNode | null = null;
    let kind: SymbolKind | null = null;

    for (const capture of match.captures) {
      if (capture.name === "name") {
        nameText = capture.node.text;
      } else {
        const k = nodeKindFromCapture(capture.name);
        if (k) {
          kind = k;
          definitionNode = capture.node;
        }
      }
    }

    if (!nameText || !kind || !definitionNode) continue;

    // Qualify every nested definition with its enclosing container. This cannot be gated
    // on `kind === "method"`: only TS/JS/Go emit a distinct method capture. Python methods
    // are `function_definition` inside a `class_definition` and Rust methods are
    // `function_item` inside an `impl_item`, so both arrive as kind "function" and would
    // otherwise be stored as free functions — leaving `URLPattern.__lt__` indistinguishable
    // from a top-level `__lt__`, and 66 different `__init__`s indistinguishable from each
    // other. findParentClass returns null at file scope, so top-level definitions are
    // unaffected in every language.
    const parentClass = findParentClass(definitionNode, language);
    const qualifiedName = parentClass ? `${parentClass}.${nameText}` : nameText;

    const positionKey = `${qualifiedName}:${definitionNode.startPosition.row}`;
    const existing = byPosition.get(positionKey);
    if (existing && existing.kind !== "constant") continue;

    byPosition.set(positionKey, {
      name: nameText,
      qualified_name: qualifiedName,
      kind,
      parent_name: parentClass,
      line_start: definitionNode.startPosition.row + 1, // 1-indexed
      line_end: definitionNode.endPosition.row + 1,
      signature: extractSignature(definitionNode, sourceLines, language),
      body_hash: computeBodyHash(definitionNode),
      export_status: detectExportStatus(definitionNode, language),
    });
  }
}

// ─── Call-Site Extraction ─────────────────────────────────

const ENCLOSING_FUNCTION_TYPES = new Set([
  "function_declaration",
  "function_definition",
  "function_item",
  "method_definition",
  "method_declaration",
  "arrow_function",
  "function_expression",
]);

const ELIXIR_DEFINITION_TARGETS = new Set(ELIXIR_DEFINITION_FORMS);

/** True when the node sits inside a module attribute: `@spec`, `@type`, `@doc`.
 *  The attribute name itself parses as a call under `@`, and so does everything
 *  written in its body — `@spec sign(t(), binary()) :: binary()` yields calls to
 *  `sign`, `t` and `binary`, none of which the program performs. The walk stops
 *  at a do_block, so calls in a function body are never mistaken for one. */
function isInsideModuleAttribute(node: TreeSitterNode): boolean {
  let current: TreeSitterNode | null = node;
  while (current) {
    if (current.type === "do_block") return false;
    if (current.type === "unary_operator" && current.childForFieldName("operator")?.text === "@") {
      return true;
    }
    current = current.parent;
  }
  return false;
}

/** True when an Elixir `call` node is part of a declaration rather than a call.
 *  Two shapes reach here: a module attribute and everything inside it, and the
 *  head of a definition — `def greet(name)` holds `greet(name)` as a call inside
 *  its own arguments, so the function appears to call itself on its own line. */
function isElixirDeclarationSite(site: TreeSitterNode): boolean {
  const parent = site.parent;
  if (!parent) return false;
  if (isInsideModuleAttribute(site)) return true;
  // A guard puts the head on the left of `when`: in
  // `def decode(str) when is_binary(str)` the head is `decode(str)` and the
  // guard `is_binary(str)` is a real call, so only the left side is skipped.
  let args = parent;
  if (parent.type === "binary_operator") {
    // Compare by span: every accessor hands back a fresh wrapper, so two reads
    // of the same node are never the same object.
    const left = parent.childForFieldName("left");
    if (!left || left.startPosition.row !== site.startPosition.row) return false;
    if (left.startPosition.column !== site.startPosition.column) return false;
    args = parent.parent!;
  }
  if (args?.type !== "arguments") return false;
  const target = args.parent?.childForFieldName("target");
  return target ? ELIXIR_DEFINITION_TARGETS.has(target.text) : false;
}

function findEnclosingFunction(node: TreeSitterNode): string {
  let current = node.parent;
  while (current) {
    if (ENCLOSING_FUNCTION_TYPES.has(current.type)) {
      const nameNode =
        current.childForFieldName("name") ??
        current.namedChildren.find(
          (c) =>
            c.type === "identifier" ||
            c.type === "property_identifier" ||
            c.type === "field_identifier",
        );
      if (nameNode?.text) return nameNode.text;
    }
    // Elixir: def/defp call nodes are function boundaries
    if (current.type === "call") {
      const target = current.childForFieldName("target");
      if (
        target?.text === "def" ||
        target?.text === "defp" ||
        target?.text === "defmacro" ||
        target?.text === "defmacrop"
      ) {
        const args = current.namedChildren.find((c) => c.type === "arguments");
        if (args) {
          const inner = args.namedChildren[0];
          if (inner?.type === "call") {
            const nameNode = inner.childForFieldName("target");
            if (nameNode?.text) return nameNode.text;
          } else if (inner?.type === "binary_operator") {
            const left = inner.childForFieldName("left");
            if (left?.type === "call") {
              const nameNode = left.childForFieldName("target");
              if (nameNode?.text) return nameNode.text;
            }
          }
        }
      }
    }
    // Check if inside a variable declarator with arrow function / function expression
    if (current.type === "variable_declarator") {
      const valueNode = current.childForFieldName("value");
      if (valueNode && (valueNode.type === "arrow_function" || valueNode.type === "function")) {
        const nameNode = current.childForFieldName("name");
        if (nameNode?.text) return nameNode.text;
      }
    }
    current = current.parent;
  }
  return "<module>";
}

export function extractCallSites(
  tree: TreeSitterTree,
  lang: TreeSitterLanguage,
  language: SupportedLanguage,
  sourceCode: string,
  pool: TreeSitterPool,
): ExtractedCallSite[] {
  const querySource = CALL_QUERY_MAP[language];
  if (!querySource) return [];

  let query;
  try {
    query = pool.createQuery(lang, querySource);
  } catch {
    return [];
  }

  const sites: ExtractedCallSite[] = [];
  try {
    collectCallSites(query, tree, language, sites);
  } finally {
    query.delete();
  }
  return sites;
}

function collectCallSites(
  query: TreeSitterQuery,
  tree: TreeSitterTree,
  language: SupportedLanguage,
  sites: ExtractedCallSite[],
): void {
  const matches = query.matches(tree.rootNode);
  const seen = new Set<string>();

  for (const match of matches) {
    let calleeName: string | null = null;
    let siteNode: TreeSitterNode | null = null;

    for (const capture of match.captures) {
      if (capture.name === "call.name") {
        calleeName = capture.node.text;
      } else if (capture.name === "call.site") {
        siteNode = capture.node;
      }
    }

    if (!calleeName || !siteNode) continue;
    if (language === "elixir" && isElixirDeclarationSite(siteNode)) continue;

    const line = siteNode.startPosition.row + 1; // 1-indexed
    const dedupKey = `${calleeName}:${line}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const callerContext = findEnclosingFunction(siteNode);
    let snippet = siteNode.text;
    if (snippet.length > 200) {
      snippet = snippet.slice(0, 200) + "...";
    }

    sites.push({
      callee_name: calleeName,
      caller_context: callerContext,
      line,
      snippet,
    });
  }
}
