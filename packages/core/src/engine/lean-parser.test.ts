import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TreeSitterPool } from "./tree-sitter.ts";
import { extractSymbols, extractCallSites } from "./symbol-queries.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");

const FIXTURE = readFileSync(join(fixtureDir, "sample.lean"), "utf-8");

describe("Lean parser", () => {
  let pool: TreeSitterPool;

  test("setup pool", async () => {
    pool = new TreeSitterPool();
    await pool.init();
  });

  // The grammar ships in this repository, not in a package. If it goes missing
  // from a build, every assertion below fails the same way and none of them
  // says why. This one names the cause.
  test("the vendored grammar loads", async () => {
    const { tree } = await pool.parse("def f : Nat := 0\n", "lean");
    expect(tree.rootNode.type).toBe("module");
    tree.delete();
  });

  test("extracts every named declaration form", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.qualified_name);

    expect(names).toContain("Token");
    expect(names).toContain("Color");
    expect(names).toContain("Pair");
    expect(names).toContain("Monoidish");
    expect(names).toContain("choice_ax");
    expect(names).toContain("secret");
  });

  test("namespaces qualify names, and they nest", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.qualified_name);

    // Lean's own name for this function is Auth.Token.refresh. A bare `refresh`
    // would collide with every other refresh in a project.
    expect(names).toContain("Auth.Token.refresh");
    expect(names).toContain("Auth.Token.refresh_monotone");
    expect(names).toContain("Auth.validAt");
    // Closed before the inner namespace opened, so it carries one segment.
    expect(names).toContain("Auth.outer_holds");
  });

  test("a section bounds variables, so it does not qualify a name", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const helper = symbols.find((s) => s.name === "helper");
    expect(helper?.qualified_name).toBe("helper");
    expect(helper?.parent_name).toBeNull();
  });

  test("declarations after `end` leave the namespace behind", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // `Color` sits after `end Auth`. Treating `end` as a no-op would file it
    // under Auth, and the namespace would swallow the rest of the file.
    const color = symbols.find((s) => s.name === "Color");
    expect(color?.qualified_name).toBe("Color");
  });

  test("theorem is a kind of its own, apart from function", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    expect(symbols.find((s) => s.name === "refresh_sound")?.kind).toBe("theorem");
    expect(symbols.find((s) => s.name === "outer_holds")?.kind).toBe("theorem");
    expect(symbols.find((s) => s.name === "refresh")?.kind).toBe("function");
    expect(symbols.find((s) => s.name === "Token")?.kind).toBe("struct");
    expect(symbols.find((s) => s.name === "Color")?.kind).toBe("enum");
    expect(symbols.find((s) => s.name === "Pair")?.kind).toBe("type");
    expect(symbols.find((s) => s.name === "choice_ax")?.kind).toBe("constant");
  });

  test("export_status: private=local, protected and plain=exported", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    expect(symbols.find((s) => s.name === "refresh_monotone")?.export_status).toBe("local");
    // `protected` only forces callers to write the full name. The symbol still
    // leaves the file, so it is not local.
    expect(symbols.find((s) => s.name === "refresh_sound")?.export_status).toBe("exported");
    expect(symbols.find((s) => s.name === "refresh")?.export_status).toBe("exported");
  });

  test("the signature keeps the statement and drops the proof", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // For a theorem the type is the whole claim. A signature cut at `:=` keeps
    // it; one that kept going would return the tactic script instead.
    const sound = symbols.find((s) => s.name === "refresh_sound");
    expect(sound?.signature).toContain("validAt (refresh t) now");
    expect(sound?.signature).not.toContain("simp");
  });

  test("an anonymous instance and an example produce no symbol", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // Neither can be bound to a concept, and neither has a name to bind by.
    expect(symbols.every((s) => s.name.length > 0)).toBe(true);
    expect(symbols.map((s) => s.name)).not.toContain("example");
  });

  test("call sites record the enclosing declaration", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const sites = extractCallSites(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const bump = sites.find((s) => s.callee_name === "bump");
    expect(bump?.caller_context).toBe("refresh");
  });

  test("an application in a type is a call site", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const sites = extractCallSites(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // `theorem refresh_sound ... : validAt (refresh t) now` states a fact about
    // validAt. In Lean the statement is the knowledge, so the edge is real.
    const inType = sites.filter((s) => s.caller_context === "refresh_sound");
    expect(inType.map((s) => s.callee_name)).toContain("validAt");
  });

  test("`_root_` leaves the namespace instead of nesting under it", async () => {
    const source = [
      "namespace RBTree.RBNode.Path",
      "",
      "theorem _root_.RBTree.RBNode.Ordered.zoom : True := trivial",
      "",
      "theorem inside : True := trivial",
      "",
      "end RBTree.RBNode.Path",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // Lean declares this at the top level. Applying the open namespace would
    // store RBTree.RBNode.Path._root_.RBTree.RBNode.Ordered.zoom, a name no
    // Lean project holds and nobody can look up.
    const escaped = symbols.find((s) => s.qualified_name.endsWith("Ordered.zoom"));
    expect(escaped?.qualified_name).toBe("RBTree.RBNode.Ordered.zoom");
    expect(escaped?.parent_name).toBeNull();
    expect(escaped?.name).not.toContain("_root_");

    // The escape applies to its own declaration only.
    const inside = symbols.find((s) => s.name === "inside");
    expect(inside?.qualified_name).toBe("RBTree.RBNode.Path.inside");
  });

  test("a `mutual` block does not close the namespace around it", async () => {
    const source = [
      "namespace Auth",
      "mutual",
      "  def foo : Nat := 0",
      "  def bar : Nat := 0",
      "end",
      "def baz : Nat := 0",
      "end Auth",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // `mutual` is flat in the tree and consumes an `end`. Ignoring it makes
    // that `end` close Auth, and every declaration below it loses the
    // namespace it is written inside.
    expect(symbols.find((s) => s.name === "baz")?.qualified_name).toBe("Auth.baz");
    expect(symbols.find((s) => s.name === "foo")?.qualified_name).toBe("Auth.foo");
  });

  test("a `public section` does not close the namespace around it", async () => {
    const source = [
      "namespace Auth",
      "@[expose] public section",
      "def foo : Nat := 0",
      "end",
      "def bar : Nat := 0",
      "end Auth",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    expect(symbols.find((s) => s.name === "bar")?.qualified_name).toBe("Auth.bar");
  });

  test("a default parameter does not truncate the signature", async () => {
    const source = [
      'def greet (name : String := "world") : String := name',
      "def add (n : Nat) (m : Nat := 0) : Nat := n + m",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // `:=` gives a parameter its default as well as opening the body. Cutting
    // at the first one drops the return type, and for a theorem that is the
    // statement being proved.
    const greet = symbols.find((s) => s.name === "greet");
    expect(greet?.signature).toBe('def greet (name : String := "world") : String');
    expect(symbols.find((s) => s.name === "add")?.signature).toBe(
      "def add (n : Nat) (m : Nat := 0) : Nat",
    );
  });

  test("a proof body stops before the next declaration's comment", async () => {
    const source = [
      "theorem first : True := by",
      "  trivial",
      "",
      "-- documents second",
      "def second : Nat := 0",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // A Lean tactic block closes on indentation, so the body runs to the row
    // where the next declaration starts. Counting that row and the blank rows
    // before it makes the comment describing `second` retrieve as a claim
    // about `first`.
    const first = symbols.find((s) => s.name === "first");
    expect(first?.line_start).toBe(1);
    expect(first?.line_end).toBe(2);
  });

  test("a proof body stops before a multi-line block comment", async () => {
    const source = [
      "theorem first : True := by",
      "  trivial",
      "",
      "/-- Doc for second,",
      "    continued on this row. -/",
      "def second : Nat := 0",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // A block comment spans two rows, so the boundary sits further from the
    // proof than a line comment puts it. The end row must still be the last
    // row of the proof.
    expect(symbols.find((s) => s.name === "first")?.line_end).toBe(2);
  });

  test("the trim never eats the declaration it belongs to", async () => {
    const source = ["-- leading comment", "def only : Nat := 0", ""].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    const only = symbols.find((s) => s.name === "only");
    expect(only?.line_start).toBe(2);
    expect(only?.line_end).toBe(2);
  });

  test("body_hash ignores a comment the trim removed", async () => {
    const withComment = [
      "theorem first : True := by",
      "  trivial",
      "",
      "-- documents second",
      "def second : Nat := 0",
      "",
    ].join("\n");
    const changedComment = withComment.replace("-- documents second", "-- reworded entirely");

    const a = await pool.parse(withComment, "lean");
    const symbolsA = extractSymbols(a.tree, a.lang, "lean", withComment, pool);
    a.tree.delete();
    const b = await pool.parse(changedComment, "lean");
    const symbolsB = extractSymbols(b.tree, b.lang, "lean", changedComment, pool);
    b.tree.delete();

    // Editing the comment above `second` must not report drift in `first`.
    // Hashing the node text would, because the node still spans that row.
    const hashA = symbolsA.find((s) => s.name === "first")?.body_hash;
    const hashB = symbolsB.find((s) => s.name === "first")?.body_hash;
    expect(hashA).toBe(hashB!);
  });

  test("an unterminated namespace still yields its symbols", async () => {
    const source = "namespace Draft\n\ndef inProgress : Nat := 0\n";
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // A file being edited is the normal case, not an error case.
    expect(symbols.map((s) => s.qualified_name)).toContain("Draft.inProgress");
  });

  test("a stray `end` does not throw", async () => {
    const source = "end Nope\n\ndef after : Nat := 0\n";
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    expect(symbols.map((s) => s.qualified_name)).toContain("after");
  });

  // ─── Syntax, macro and notation commands ────────────────

  test("a tactic is named by the token that calls it", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.name);

    // Lean generates an identifier for a `syntax` command that declares none.
    // The token is what the file writes in a proof and what a reader searches
    // for, so the token is the name.
    expect(names).toContain("expiry_tac");
    expect(names).toContain("bump_tac");
    expect(symbols.find((s) => s.name === "expiry_tac")?.kind).toBe("syntax");
    expect(symbols.find((s) => s.name === "bump_tac")?.kind).toBe("syntax");
  });

  test("`(name := X)` names the tactic, and `(priority := N)` does not", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.name);

    // Both prefixes fill the same `value` field in the tree. Reading that field
    // without checking which keyword opened it names this tactic `high`.
    expect(names).toContain("refreshTac");
    expect(names).toContain("priority_tac");
    expect(names).not.toContain("high");
  });

  test("a namespace does not qualify a token, a category or an option", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const qualified = symbols.map((s) => s.qualified_name);

    // All three sit inside `namespace Auth.Syntax`. Lean registers each under
    // the literal name written, so `Auth.Syntax.expiry_tac` is a name no Lean
    // project holds and a binding to it could never be looked up.
    expect(qualified).toContain("expiry_tac");
    expect(qualified).toContain("authRule");
    expect(qualified).toContain("auth.verbose");

    // The two forms that do declare a name in the namespace still carry it.
    expect(qualified).toContain("Auth.Syntax.refreshTac");
    expect(qualified).toContain("Auth.Syntax.authRef");

    // `register_cmd` covers three keywords, and only the two option forms name
    // a global. An error explanation is read as an ordinary declaration, so the
    // namespace applies to it.
    expect(qualified).toContain("Auth.Syntax.authFailed");
    expect(qualified).not.toContain("authFailed");
  });

  test("`local` stops at the file, `scoped` does not", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    expect(symbols.find((s) => s.name === "file_only_tac")?.export_status).toBe("local");
    // `scoped` ties the syntax to a namespace. Opening that namespace elsewhere
    // brings it back, so the symbol still leaves the file.
    expect(symbols.find((s) => s.name === "namespace_tac")?.export_status).toBe("exported");
  });

  test("a notation is named by its opening token", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.name);

    // The operator is written with the spaces it needs when printed.
    expect(names).toContain("⊕'");
    // The grammar lifts the closing bracket of a pair into its `op` field and
    // leaves the opening one under an ERROR node. The opening half is the one
    // worth indexing.
    expect(names).toContain("⟦");
    expect(names).not.toContain("⟧");
  });

  test("the signature of a named tactic keeps its head", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // `value` holds the operand of the `(name := ...)` prefix as well as a
    // declaration body. Reading it as a body cuts the signature at `syntax
    // (name :=` and loses the token and the category.
    const named = symbols.find((s) => s.name === "refreshTac");
    expect(named?.signature).toContain("refresh_tac");
    expect(named?.signature).toContain("tactic");
  });

  test("`macro_rules` adds cases to a tactic, so it declares no symbol", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // The block implements `expiry_tac`, which the `syntax` command above it
    // already declares. Only one row claims the name, and it is the
    // declaration. This is the rule `example` follows: no new name, no symbol.
    expect(symbols.filter((s) => s.name === "expiry_tac").length).toBe(1);
    expect(symbols.find((s) => s.name === "expiry_tac")?.signature).toStartWith("syntax");
  });

  // ─── The `elab` command ─────────────────────────────────

  test("an elaborator is named the same three ways a macro is", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.name);

    // `elab` declares the syntax and the elaborator in one command, so the
    // token names it exactly as it names a `syntax` command.
    expect(names).toContain("audit_tac");
    expect(names).toContain("audit_do");
    expect(symbols.find((s) => s.name === "audit_tac")?.kind).toBe("syntax");

    // `(name := X)` declares the identifier, and the namespace qualifies it.
    expect(symbols.map((s) => s.qualified_name)).toContain("Auth.Syntax.auditWith");

    // The `do` body of `audit_do` ends where the block ends. A body that ran
    // on would take this declaration with it.
    expect(symbols.map((s) => s.qualified_name)).toContain("Auth.Syntax.afterElab");
  });

  test("an `elab` block leaves the declarations after it alone", async () => {
    const source = [
      'elab "my_elab" : tactic => pure ()',
      "",
      'elab (name := namedElab) "other_elab" : tactic => pure ()',
      "",
      'elab "with_do" : tactic => do',
      "  pure ()",
      "",
      'macro (name := namedMacro) "mac" : tactic => `(tactic| skip)',
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // Without an `elab` rule the first three declarations collapsed into one
    // ERROR node spanning rows 1-6, and the macro below them was the only
    // symbol the file produced.
    const names = symbols.map((s) => s.name);
    expect(names).toContain("my_elab");
    expect(names).toContain("namedElab");
    expect(names).toContain("with_do");
    expect(names).toContain("namedMacro");

    // Each one claims its own row, not the span of the block above it.
    expect(symbols.find((s) => s.name === "my_elab")?.line_start).toBe(1);
    expect(symbols.find((s) => s.name === "namedElab")?.line_start).toBe(3);
    expect(symbols.find((s) => s.name === "with_do")?.line_start).toBe(5);
  });

  test("a `meta section` is a section, so it does not qualify a name", async () => {
    const source = [
      "namespace Auth",
      "meta section",
      "def foo : Nat := 0",
      "end",
      "def bar : Nat := 0",
      "end Auth",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // Lean writes `meta section` without `public` when the section is
    // meta-only. Reading it as anything else made the whole file one ERROR.
    expect(symbols.find((s) => s.name === "bar")?.qualified_name).toBe("Auth.bar");
    expect(symbols.find((s) => s.name === "foo")?.qualified_name).toBe("Auth.foo");
  });

  test("an assert command with several targets does not break the file", async () => {
    const source = ["assert_not_exists Alpha Beta Gamma", "", "def after : Nat := 0", ""].join(
      "\n",
    );
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    expect(symbols.map((s) => s.name)).toContain("after");
  });

  test("the token is found through the wrapper the parser DSL puts it in", async () => {
    const source = [
      'syntax &"nonreserved" : tactic',
      'elab &"elab_nonres" : tactic => pure ()',
      'syntax "opt"? "second" : tactic',
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    const names = symbols.map((s) => s.name);
    // `&"kw"` is a nonreserved_atom and `"kw"?` a syntax_postfix, so the token
    // is a grandchild. Stopping at the wrapper dropped the first two commands
    // and named the third after its second token.
    expect(names).toContain("nonreserved");
    expect(names).toContain("elab_nonres");
    expect(names).toContain("opt");
    expect(names).not.toContain("second");
  });

  test("an escaped character in a token is resolved", async () => {
    const source = 'syntax "esc\\"q" : tactic\n';
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // A proof writes `esc"q`. Storing the source spelling keeps the backslash,
    // and the token can never be looked up.
    expect(symbols.map((s) => s.name)).toContain('esc"q');
  });

  test("one token names one tactic, however many commands declare it", async () => {
    const source = ['syntax "trans" : tactic', 'syntax "trans" term : tactic', ""].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // Lean declares one tactic through several commands with different
    // argument shapes. Two rows with one qualified_name make every lookup
    // pick one of them at random.
    expect(symbols.filter((s) => s.qualified_name === "trans").length).toBe(1);
  });

  test("a signature drops the arrow that opens a macro or elab body", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "lean");
    const symbols = extractSymbols(tree, lang, "lean", FIXTURE, pool);
    tree.delete();

    // A declaration writes `:=` and these write `=>`. Stripping only `:=`
    // stored every tactic signature with a dangling arrow.
    expect(symbols.find((s) => s.name === "bump_tac")?.signature).toBe('macro "bump_tac" : tactic');
    expect(symbols.find((s) => s.name === "audit_tac")?.signature).toBe(
      'elab "audit_tac" : tactic',
    );
  });

  test("`local` stops a declaration at the file, as it stops a command", async () => {
    const source = "local instance myInst : Inhabited Nat := \u27e80\u27e9\n";
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // The keyword sits in decl_modifiers on the parent, so testing only for
    // `private` reported a file-local instance as public API.
    expect(symbols.find((s) => s.name === "myInst")?.export_status).toBe("local");
  });

  test("a command with no token and no name yields nothing", async () => {
    const source = [
      // No string token and no `(name := ...)`: the head is an identifier, so
      // there is nothing a proof would write.
      "syntax ident_only : term",
      "",
      // A `hole` names nothing, and the second form binds nothing at all.
      "initialize _ ← pure ()",
      "",
      "initialize registerTraceClass `foo",
      "",
    ].join("\n");
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    expect(symbols).toEqual([]);
  });

  test("a macro is not named after a string in its own expansion", async () => {
    const source = 'macro emptyHead : tactic => "not_a_token"\n';
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // The grammar types a macro body as any term, so a bare string literal sits
    // directly under the command. The token search stops where the body starts,
    // and the head declares no token, so this macro names nothing.
    expect(symbols).toEqual([]);
  });

  test("a token keeps the characters it stands for, not its escapes", async () => {
    // Byte-for-byte the notation from Mathlib/Data/Finset/Sups.lean. The Lean
    // literal holds four backslashes, which Lean reads as the two-character
    // operator `\\`.
    const source = String.raw`infixl:74 " \\\\ " => Finset.diffs` + "\n";
    const { tree, lang } = await pool.parse(source, "lean");
    const symbols = extractSymbols(tree, lang, "lean", source, pool);
    tree.delete();

    // Storing the raw source between the quotes would put a four-character name
    // in the index that no Lean file writes and no search finds.
    expect(symbols.map((s) => s.name)).toContain(String.raw`\\`);
  });
});
