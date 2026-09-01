import { createHash } from "crypto";
import { SYMBOL_KINDS } from "@/types/index.ts";
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

// Lean wraps every declaration in a `declaration` node that holds the modifiers
// and one form node. The form node carries the name, so the query captures the
// form and detectExportStatus reads the modifiers off its parent.
//
// `lemma` parses as `theorem`, and `class` parses as `structure`, so neither
// needs a pattern. `example` has no name and defines nothing a reader can bind
// to, so it is left out. An anonymous `instance` has no name field and drops
// out on its own, because the pattern requires one.
//
// The seven command patterns below carry no `@name` capture. A declaration names
// itself in one field, but a Lean command has three ways to do it — an explicit
// `(name := X)`, a `name` field, or the token it declares — and only the first
// match wins. leanCommandName picks between them, and collectSymbols calls it
// when a Lean match arrives without a name.
//
// `elab` declares an elaborator together with the syntax that runs it, so it
// names a tactic the same way `macro` does. The vendored grammar carries a
// patch that adds the rule: upstream has `elab_rules` and no `elab`.
//
// `macro_rules` and `elab_rules` are absent on purpose. Both add cases to a
// syntax another command already declared, so neither introduces a name to bind
// to. This is the rule `example` follows: no new name, no symbol.
const LEAN_QUERY = `
(theorem name: (identifier) @name) @definition.theorem
(def name: (identifier) @name) @definition.function
(abbrev name: (identifier) @name) @definition.type
(structure name: (identifier) @name) @definition.struct
(inductive name: (identifier) @name) @definition.enum
(instance name: (identifier) @name) @definition.impl
(axiom name: (identifier) @name) @definition.constant
(opaque name: (identifier) @name) @definition.constant
(constant name: (identifier) @name) @definition.constant
(syntax_cmd) @definition.syntax
(macro_cmd) @definition.syntax
(elab_cmd) @definition.syntax
(notation_decl_cmd) @definition.syntax
(declare_syntax_cat_cmd) @definition.syntax
(initialize) @definition.constant
(register_cmd) @definition.constant
`;

const QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TYPESCRIPT_QUERY,
  javascript: JAVASCRIPT_QUERY,
  python: PYTHON_QUERY,
  go: GO_QUERY,
  rust: RUST_QUERY,
  elixir: ELIXIR_QUERY,
  lean: LEAN_QUERY,
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

// Lean applies functions by juxtaposition, so `f a b` is a left-nested `app`
// and only the innermost `fn` is the identifier. One pattern therefore reports
// each application once.
//
// This matches applications in a type as well as in a body, and that is
// deliberate. `theorem refresh_sound : valid (refresh t)` states a fact about
// `valid` and `refresh`. In Lean the statement is the knowledge, so an edge
// from the type is the edge worth having.
const LEAN_CALL_QUERY = `
(app fn: (identifier) @call.name) @call.site
`;

const CALL_QUERY_MAP: Record<SupportedLanguage, string> = {
  typescript: TS_CALL_QUERY,
  javascript: TS_CALL_QUERY,
  python: PYTHON_CALL_QUERY,
  go: GO_CALL_QUERY,
  rust: RUST_CALL_QUERY,
  elixir: ELIXIR_CALL_QUERY,
  lean: LEAN_CALL_QUERY,
};

function nodeKindFromCapture(captureName: string): SymbolKind | null {
  const parts = captureName.split(".");
  if (parts.length < 2 || parts[0] !== "definition") return null;
  const kind = parts[1] as string;
  // SYMBOL_KINDS is the list the SymbolKind type is built from, so a kind added
  // to the type is accepted here without a second edit.
  return (SYMBOL_KINDS as readonly string[]).includes(kind) ? (kind as SymbolKind) : null;
}

// ─── Lean Namespace Scopes ────────────────────────────────

/** Lean's escape to the top level. A name written with it ignores every open
 *  namespace, so it is the whole name. */
const LEAN_ROOT_PREFIX = "_root_.";

/** Every Lean command that opens a scope an `end` closes.
 *
 *  The grammar models all of these flat: the declarations between the opener
 *  and its `end` are siblings of both, not children. `mutual` groups
 *  recursive definitions and `public section` sets visibility, so neither
 *  names anything, but each still consumes an `end`. */
const LEAN_SCOPE_OPENERS = new Set(["namespace", "section", "mutual", "public_section"]);

/** One open `namespace` and the rows it covers. */
interface LeanScope {
  name: string;
  startRow: number;
  endRow: number;
}

/** The namespaces covering each row of a Lean file.
 *
 *  Every other language here nests a definition inside its container, so
 *  findParentClass reaches the container by walking up from the definition.
 *  Lean does not nest: `namespace`, `end` and `declaration` are all siblings of
 *  `module`, and the declarations between an open and its `end` are not its
 *  children. Walking up from a declaration therefore reaches `module` and finds
 *  nothing, which would store `Auth.Token.refresh` as a bare `refresh` and
 *  collide it with every other `refresh` in the project.
 *
 *  So the scopes are read in source order instead, and `end` closes the
 *  innermost open scope. `section` opens a scope too, and must be tracked to
 *  keep `end` aligned, but it never contributes to a name: a section bounds
 *  variables, and a namespace bounds names. */
function collectLeanScopes(root: TreeSitterNode): LeanScope[] {
  const closed: LeanScope[] = [];
  const open: { name: string | null; startRow: number }[] = [];

  for (const child of root.namedChildren) {
    if (LEAN_SCOPE_OPENERS.has(child.type)) {
      // Only a namespace contributes to a name. A section, a mutual block and
      // a public section each bound something else, but all four close with
      // the same `end`, so all four must be tracked. Miss one and its `end`
      // closes the namespace around it, and every declaration after it in the
      // file loses its namespace.
      const nameNode = child.childForFieldName("name");
      open.push({
        name: child.type === "namespace" ? (nameNode?.text ?? null) : null,
        startRow: child.startPosition.row,
      });
      continue;
    }
    if (child.type === "end") {
      const scope = open.pop();
      // `end` with nothing open is invalid Lean. Ignore it rather than throw:
      // a half-written file must still yield the symbols it already has.
      if (!scope) continue;
      if (scope.name !== null) {
        closed.push({ name: scope.name, startRow: scope.startRow, endRow: child.endPosition.row });
      }
    }
  }

  // A file that opens a namespace and never closes it is normal Lean: the
  // namespace runs to the end of the file.
  for (const scope of open) {
    if (scope.name === null) continue;
    closed.push({ name: scope.name, startRow: scope.startRow, endRow: root.endPosition.row });
  }

  return closed;
}

/** The last row a Lean declaration really occupies. Rows are 0-indexed, as
 *  tree-sitter reports them.
 *
 *  A Lean tactic block closes on indentation, not on a token, so a `:= by`
 *  body runs to the row where the next declaration starts. Tree-sitter reports
 *  that boundary as an exclusive end at column 0, which means the reported end
 *  row belongs to the *next* declaration and not to this one. It also leaves
 *  the blank rows between the two inside the reported range.
 *
 *  Counting those rows makes the scanner claim them for this symbol. The doc
 *  comment above the next declaration then lands in this chunk, and a comment
 *  reading "never moves its expiry backwards" is retrieved as a claim about
 *  the theorem above it — the wrong claim about the wrong symbol, which is
 *  worse than not retrieving it at all. It also moves body_hash whenever the
 *  next declaration's comment changes, reporting drift in untouched code. */
function trimLeanEndRow(
  sourceLines: string[],
  startRow: number,
  endRow: number,
  endColumn: number,
): number {
  let end = endRow;
  // An end at column 0 stops before that row, so the row is not part of the
  // declaration. Comments are siblings of the declaration in this grammar, so
  // dropping the row is enough and no comment needs to be recognised here.
  if (endColumn === 0 && end > startRow) end--;
  while (end > startRow && (sourceLines[end]?.trim() ?? "") === "") end--;
  return end;
}

/** The `register_cmd` keywords that name a global. An option is registered in
 *  a table of its own under the literal name written: `register_option pp.all`
 *  declares that option from inside any namespace, not `Foo.pp.all`. */
const LEAN_GLOBAL_REGISTER_KEYWORDS = new Set(["register_option", "register_builtin_option"]);

/** True when Lean records the command's name as written, so no open namespace
 *  prefixes it. `declare_syntax_cat authRule` declares the category `authRule`
 *  from inside any namespace.
 *
 *  `register_cmd` covers three keywords, and only the two option forms are
 *  known to take a global name. `register_error_explanation` is left out: it is
 *  treated as an ordinary declaration, which is the reversible choice, because
 *  a wrongly global name is stored unqualified and a search for the qualified
 *  one never finds it. */
function leanNameIsGlobal(node: TreeSitterNode): boolean {
  if (node.type === "declare_syntax_cat_cmd") return true;
  if (node.type !== "register_cmd") return false;
  // The keyword opens the command today, but reading children[0] would tie this
  // to that position. A grammar that later admits an attribute, a modifier or
  // an ERROR node in front would then match nothing here, and every option name
  // would quietly gain a namespace it does not have.
  return node.children.some((child) => LEAN_GLOBAL_REGISTER_KEYWORDS.has(child.type));
}

/** A name read off a Lean command, and whether the open namespace applies. */
interface LeanCommandName {
  text: string;
  /** True when Lean records the name as written, so no namespace prefixes it. */
  global: boolean;
}

/** The name a Lean command declares, or null when it declares none.
 *
 *  A command names itself in one of three ways, and they are tried in this
 *  order:
 *
 *  1. `(name := myTac)`. The grammar stores the operand in a `value` field and
 *     records which keyword opened it in `attr`. `(priority := high)` fills the
 *     same `value` field, so the `attr` test is what keeps a priority from being
 *     stored as the tactic's name.
 *  2. A `name` field. `declare_syntax_cat`, `register_option`, `initialize` and
 *     the `syntax foo := ...` abbreviation all use it. `initialize _ <- ...`
 *     puts a `hole` there, which names nothing.
 *  3. The first string token. `syntax "ring_nf" : tactic` declares no
 *     identifier, and Lean generates one, but `ring_nf` is what the file calls
 *     the tactic and what a reader searches for.
 *
 *  The first token is taken rather than the grammar's `op` field. For a bracket
 *  pair such as `notation "[[" a "]]" => f a`, `op` holds the closing `]]`,
 *  and the opening token is the half worth indexing.
 *
 *  Only forms 1 and 2 can produce a name a namespace prefixes, and form 2 only
 *  outside the global-name commands. A token is parsed from a global table, so
 *  `syntax "ring_nf"` inside `namespace Mathlib.Tactic` still writes `ring_nf`
 *  in a proof. Storing `Mathlib.Tactic.ring_nf` would repeat the `_root_` bug:
 *  a qualified name no Lean project holds, and a binding to it that never
 *  resolves. */
function leanCommandName(node: TreeSitterNode): LeanCommandName | null {
  const global = leanNameIsGlobal(node);

  if (node.childForFieldName("attr")?.text === "name") {
    const explicit = node.childForFieldName("value");
    if (explicit?.type === "identifier") return { text: explicit.text, global };
  }

  const named = node.childForFieldName("name");
  if (named?.type === "identifier") return { text: named.text, global };

  // The head ends where the body starts. `macro` marks its body `body` and
  // `notation` marks its expansion `target`.
  const body = node.childForFieldName("body") ?? node.childForFieldName("target");
  const token = firstLeanToken(node, body);
  if (!token) return null;
  // Trim inside the quotes as well: an operator is written with the spaces it
  // needs when printed, and ` +++ ` is called `+++`.
  const text = decodeLeanString(token.text.slice(1, -1)).trim();
  // An escape can decode to a control character, and a name holding one breaks
  // every line-oriented reader of the index. A token like this names no tactic
  // a proof could write, so it is dropped the way an empty token is.
  if (!text || hasControlCharacter(text)) return null;
  return { text, global: true };
}

/** True when the text holds a C0 control character or DEL. */
function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** The text a Lean string literal stands for.
 *
 *  A token is read from the source, so it still carries its escapes. Mathlib
 *  writes the `\\` operator as `" \\\\ "`, and storing those four characters
 *  puts a name in the index that no Lean file writes and no search finds. */
function decodeLeanString(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/g, (_match, escape: string) => {
    const lead = escape[0]!;
    if (lead === "u" || lead === "x") {
      return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    }
    return LEAN_STRING_ESCAPES[lead] ?? escape;
  });
}

const LEAN_STRING_ESCAPES: Record<string, string> = {
  n: "\n",
  t: "\t",
  r: "\r",
  "\\": "\\",
  '"': '"',
  "'": "'",
};

const LEAN_TOKEN_WRAPPERS = new Set([
  "ERROR",
  "nonreserved_atom",
  "syntax_postfix",
  "syntax_alt",
  "paren",
]);

/** The first string token a Lean command declares, in source order, from the
 *  rows before `body` starts.
 *
 *  The search enters the nodes that wrap a token without being one, and
 *  nothing else. A header writes its token through the parser DSL, so the
 *  `str_lit` is often a grandchild: `&"kw"` is a `nonreserved_atom`, `"kw"?` a
 *  `syntax_postfix`, `"a" <|> "b"` a `syntax_alt`, and a parenthesised group a
 *  `paren`. Stopping at the wrapper skips the real token and names the command
 *  after the next one, or after nothing at all.
 *
 *  An ERROR holds a token the grammar could not place. `notation "[[" a "]]"
 *  => f a` leaves the opening `[[` under an ERROR and lifts only the closing
 *  `]]`, so skipping ERROR nodes names that notation after its closing bracket.
 *
 *  `body` bounds the search, and a command that declares no token must return
 *  null rather than a string taken from its expansion. A macro body is usually
 *  a `quotation`, which the search would not enter, but the grammar types that
 *  body as any term: `macro emptyHead : tactic => "not_a_token"` puts a bare
 *  string literal directly under the command, and without the bound it names
 *  the macro after its own expansion. */
function firstLeanToken(node: TreeSitterNode, body: TreeSitterNode | null): TreeSitterNode | null {
  for (const child of node.namedChildren) {
    if (body && startsAtOrAfter(child, body)) break;
    if (child.type === "str_lit") return child;
    if (!LEAN_TOKEN_WRAPPERS.has(child.type)) continue;
    const recovered = firstLeanToken(child, body);
    if (recovered) return recovered;
  }
  return null;
}

/** True when `node` starts at or after `mark`, in source order. */
function startsAtOrAfter(node: TreeSitterNode, mark: TreeSitterNode): boolean {
  const a = node.startPosition;
  const b = mark.startPosition;
  return a.row > b.row || (a.row === b.row && a.column >= b.column);
}

/** The dotted namespace prefix for a row, outermost first. */
function leanNamespacePrefix(scopes: LeanScope[], row: number): string | null {
  const names = scopes
    .filter((scope) => scope.startRow < row && row <= scope.endRow)
    .sort((a, b) => a.startRow - b.startRow)
    .map((scope) => scope.name);
  return names.length > 0 ? names.join(".") : null;
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

  // Lean marks the body in the tree, so the text before it is the whole
  // signature. Searching the text for `:=` instead would stop at the first
  // one, and `:=` also gives a parameter its default value:
  // `def greet (name : String := "world") : String` would cut after
  // `(name : String` and lose the return type. For a theorem the type is the
  // statement being proved, so that loses the claim itself.
  if (language === "lean") {
    // `value` holds the operand of a `(name := X)` or `(priority := N)` prefix
    // as well as a declaration body, and `attr` is what tells them apart.
    // Reading the prefix as a body cuts `syntax (name := ringNF) "ring_nf"` down
    // to `syntax (name :=`.
    const isNamedAttr = node.childForFieldName("attr") !== null;
    const body =
      node.childForFieldName("body") ?? (isNamedAttr ? null : node.childForFieldName("value"));
    if (body && body.startPosition.row === startLine) {
      const head = sourceLines[startLine]?.slice(0, body.startPosition.column) ?? "";
      // The separator is not part of the body node, so drop what it leaves.
      // A declaration writes `:=`; `macro` and `elab` write `=>`.
      sig = head
        .trim()
        .replace(/(:=|=>)$/, "")
        .trim();
    } else if (body) {
      const head: string[] = [];
      for (let i = startLine; i < body.startPosition.row && i < sourceLines.length; i++) {
        head.push(sourceLines[i]!);
      }
      head.push(sourceLines[body.startPosition.row]?.slice(0, body.startPosition.column) ?? "");
      sig = head
        .join("\n")
        .trim()
        .replace(/(:=|=>)$/, "")
        .trim();
    } else {
      // A structure, an inductive or a class has no body field. It opens with
      // `where`, which never appears inside a binder.
      const whereStart = sig.search(/\bwhere\b/);
      if (whereStart > 0) sig = sig.slice(0, whereStart).trim();
    }
    if (sig.length > 500) sig = sig.slice(0, 500) + "...";
    return sig || null;
  }

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

/** Hash an inclusive row range. Rows are 0-indexed. */
function hashLines(sourceLines: string[], startRow: number, endRow: number): string | null {
  const text = sourceLines.slice(startRow, endRow + 1).join("\n");
  if (text.length === 0) return null;
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
  if (language === "lean") {
    // A command carries its own visibility keyword, and the keyword is an
    // anonymous child of the command rather than a `decl_modifiers` node.
    // `local` stops the syntax at the end of the file. `scoped` does not: it
    // ties the syntax to a namespace, and opening that namespace elsewhere
    // brings it back, so a scoped command still leaves the file.
    if (node.children.some((c) => c.type === "local")) return "local";
    // The modifiers sit on the enclosing `declaration`, beside the form node.
    // `private` and `local` both stop the symbol at the end of the file.
    // `protected` does not: it only forces callers to write the full name, so
    // the symbol still leaves the file.
    const modifiers = node.parent?.namedChildren.find((c) => c.type === "decl_modifiers");
    const text = modifiers?.text ?? "";
    return text.includes("private") || text.includes("local") ? "local" : "exported";
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
  const leanScopes = language === "lean" ? collectLeanScopes(tree.rootNode) : [];

  try {
    collectSymbols(query, tree, language, sourceLines, byPosition, leanScopes);
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
  leanScopes: LeanScope[],
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

    // A Lean command pattern captures the command and no name, because the
    // field that holds the name depends on how the command was written.
    let leanGlobalName = false;
    if (!nameText && kind && definitionNode && language === "lean") {
      const command = leanCommandName(definitionNode);
      if (command) {
        nameText = command.text;
        leanGlobalName = command.global;
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
    // Lean writes `_root_.` in front of a name to leave the open namespace and
    // declare at the top level. `theorem _root_.RBTree.RBNode.Ordered.zoom`
    // inside `namespace RBTree.RBNode.Path` names
    // RBTree.RBNode.Ordered.zoom, so applying the namespace here would store
    // RBTree.RBNode.Path._root_.RBTree.RBNode.Ordered.zoom — a name no Lean
    // project holds, bound to a symbol nobody can look up.
    const isLeanRoot = language === "lean" && nameText.startsWith(LEAN_ROOT_PREFIX);
    const symbolName = isLeanRoot ? nameText.slice(LEAN_ROOT_PREFIX.length) : nameText;

    const parentClass =
      isLeanRoot || leanGlobalName
        ? null
        : language === "lean"
          ? leanNamespacePrefix(leanScopes, definitionNode.startPosition.row)
          : findParentClass(definitionNode, language);
    const qualifiedName = parentClass ? `${parentClass}.${symbolName}` : symbolName;

    const startRow = definitionNode.startPosition.row;
    // A token names a tactic, and Lean lets one tactic be declared by several
    // commands with different argument shapes. Keying those by row stores the
    // same qualified_name twice, and every lookup then picks one of them at
    // random. Key a token-named command by the name alone, so the command that
    // declares it first is the one row that claims it.
    const positionKey = leanGlobalName ? qualifiedName : `${qualifiedName}:${startRow}`;
    const existing = byPosition.get(positionKey);
    if (existing && existing.kind !== "constant") continue;

    // Only Lean needs the trim: every other grammar here closes a body on a
    // token, so its end row is already the last row of the declaration.
    const endRow =
      language === "lean"
        ? trimLeanEndRow(
            sourceLines,
            startRow,
            definitionNode.endPosition.row,
            definitionNode.endPosition.column,
          )
        : definitionNode.endPosition.row;

    byPosition.set(positionKey, {
      name: symbolName,
      qualified_name: qualifiedName,
      kind,
      parent_name: parentClass,
      line_start: startRow + 1, // 1-indexed
      line_end: endRow + 1,
      signature: extractSignature(definitionNode, sourceLines, language),
      // Hash the rows the symbol actually claims. Hashing the node text would
      // fold a trimmed-away comment back in and report drift for it.
      body_hash:
        endRow === definitionNode.endPosition.row
          ? computeBodyHash(definitionNode)
          : hashLines(sourceLines, startRow, endRow),
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

/** The Lean declaration forms that bound a body, and so name a call's caller.
 *
 *  The command forms are absent. Each one names itself through leanCommandName
 *  rather than through a `name` field, and findEnclosingFunction reads the
 *  `name` field, so a command would report no caller and the walk would carry
 *  on past it. `<module>` is what it reports instead, which is the honest
 *  answer for a call written in a macro body. */
const LEAN_DECLARATION_TYPES = new Set([
  "theorem",
  "def",
  "abbrev",
  "structure",
  "inductive",
  "instance",
  "axiom",
  "opaque",
  "constant",
]);

function findEnclosingFunction(node: TreeSitterNode, language: SupportedLanguage): string {
  let current = node.parent;
  while (current) {
    // Checked before the shared types, and only for Lean: these node names are
    // ordinary words, and matching them in another grammar would rename that
    // language's callers.
    if (language === "lean" && LEAN_DECLARATION_TYPES.has(current.type)) {
      const nameNode = current.childForFieldName("name");
      // An anonymous instance has no name. Keep walking: there is nothing
      // useful to report, and <module> is the honest answer.
      if (nameNode?.text) return nameNode.text;
    }
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

    const callerContext = findEnclosingFunction(siteNode, language);
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
