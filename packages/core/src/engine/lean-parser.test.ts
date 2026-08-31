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
});
