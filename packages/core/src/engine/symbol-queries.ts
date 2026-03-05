import { createHash } from "crypto";
import type { SupportedLanguage, SymbolKind, ExtractedSymbol, ExtractedCallSite } from "@/types/index.ts";
import type { TreeSitterLanguage, TreeSitterTree, TreeSitterNode } from "./tree-sitter.ts";
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
`;

const JAVASCRIPT_QUERY = `
(function_declaration name: (identifier) @name) @definition.function
(class_declaration name: (identifier) @name) @definition.class
(method_definition name: (property_identifier) @name) @definition.method
(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: [(arrow_function) (function_expression)])) @definition.function
`;

const PYTHON_QUERY = `
(function_definition name: (identifier) @name) @definition.function
(class_definition name: (identifier) @name) @definition.class
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

const QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TYPESCRIPT_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
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

const CALL_QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TS_CALL_QUERY,
  javascript: TS_CALL_QUERY,
  python: PYTHON_CALL_QUERY,
  go: GO_CALL_QUERY,
  rust: RUST_CALL_QUERY,
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
  ];
  return valid.includes(kind as SymbolKind) ? (kind as SymbolKind) : null;
}

function extractSignature(node: TreeSitterNode, sourceLines: string[]): string | null {
  const startLine = node.startPosition.row;
  const endLine = Math.min(startLine + 2, node.endPosition.row);
  const lines: string[] = [];
  for (let i = startLine; i <= endLine; i++) {
    if (i < sourceLines.length) {
      lines.push(sourceLines[i]!);
    }
  }
  let sig = lines.join("\n").trim();
  // Truncate at opening brace/colon for body
  const bodyStart = sig.search(/\{|\bdo\b/);
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

function findParentClass(node: TreeSitterNode): string | null {
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
    current = current.parent;
  }
  return null;
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
  const symbols: ExtractedSymbol[] = [];

  let query;
  try {
    query = pool.createQuery(lang, querySource);
  } catch {
    // Query compilation failed for this grammar — skip
    return [];
  }

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

    const parentClass = kind === "method" ? findParentClass(definitionNode) : null;
    const qualifiedName = parentClass ? `${parentClass}.${nameText}` : nameText;

    symbols.push({
      name: nameText,
      qualified_name: qualifiedName,
      kind,
      parent_name: parentClass,
      line_start: definitionNode.startPosition.row + 1, // 1-indexed
      line_end: definitionNode.endPosition.row + 1,
      signature: extractSignature(definitionNode, sourceLines),
      body_hash: computeBodyHash(definitionNode),
      export_status: detectExportStatus(definitionNode, language),
    });
  }

  query.delete();
  return symbols;
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
    // Check if inside a variable declarator with arrow function / function expression
    if (current.type === "variable_declarator") {
      const valueNode = current.childForFieldName("value");
      if (
        valueNode &&
        (valueNode.type === "arrow_function" || valueNode.type === "function")
      ) {
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

  const matches = query.matches(tree.rootNode);
  const sites: ExtractedCallSite[] = [];
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

  query.delete();
  return sites;
}
