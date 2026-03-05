import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TreeSitterPool } from "./tree-sitter.ts";
import { extractSymbols, extractCallSites } from "./symbol-queries.ts";

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), "../../test/fixtures");

const FIXTURE = readFileSync(join(fixtureDir, "sample.ex"), "utf-8");
const PETNAME_FIXTURE = readFileSync(join(fixtureDir, "petname.ex"), "utf-8");
const IDENTITY_FIXTURE = readFileSync(join(fixtureDir, "identity.ex"), "utf-8");

describe("Elixir parser", () => {
  let pool: TreeSitterPool;

  test("setup pool", async () => {
    pool = new TreeSitterPool();
    await pool.init();
  });

  test("extracts symbols from sample.ex", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "elixir");
    const symbols = extractSymbols(tree, lang, "elixir", FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.qualified_name);

    // Module
    expect(names).toContain("Arc.Storage");
    // Public functions (qualified with module)
    expect(names).toContain("Arc.Storage.hello");  // def hello do (no parens)
    expect(names).toContain("Arc.Storage.greet");
    expect(names).toContain("Arc.Storage.decode"); // with guard
    // Private functions
    expect(names).toContain("Arc.Storage.normalize_input");
    expect(names).toContain("Arc.Storage.validate"); // defp with guard
    // Nested module (qualified with parent)
    expect(names).toContain("Arc.Storage.Helper");
    expect(names).toContain("Helper.run");
    // Protocol and its callback
    expect(names).toContain("Arc.Serializable");
    expect(names).toContain("Arc.Serializable.serialize");
  });

  test("export_status: def=exported, defp=local", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "elixir");
    const symbols = extractSymbols(tree, lang, "elixir", FIXTURE, pool);
    tree.delete();

    const hello = symbols.find((s) => s.name === "hello");
    const normalize = symbols.find((s) => s.name === "normalize_input");
    const validate = symbols.find((s) => s.name === "validate");

    expect(hello?.export_status).toBe("exported");
    expect(normalize?.export_status).toBe("local");
    expect(validate?.export_status).toBe("local");
  });

  test("petname.ex: extracts module and binary-pattern functions", async () => {
    const { tree, lang } = await pool.parse(PETNAME_FIXTURE, "elixir");
    const symbols = extractSymbols(tree, lang, "elixir", PETNAME_FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.qualified_name);
    expect(names).toContain("Arc.Identity.Petname");
    expect(names).toContain("Arc.Identity.Petname.from_public_key");
    expect(names).toContain("Arc.Identity.Petname.short");
  });

  test("identity.ex: extracts functions with struct patterns and do: shorthand", async () => {
    const { tree, lang } = await pool.parse(IDENTITY_FIXTURE, "elixir");
    const symbols = extractSymbols(tree, lang, "elixir", IDENTITY_FIXTURE, pool);
    tree.delete();

    const names = symbols.map((s) => s.qualified_name);
    expect(names).toContain("Arc.Identity");
    expect(names).toContain("Arc.Identity.generate");
    expect(names).toContain("Arc.Identity.from_seed");
    expect(names).toContain("Arc.Identity.sign");
    expect(names).toContain("Arc.Identity.verify");
    expect(names).toContain("Arc.Identity.to_x25519");
    expect(names).toContain("Arc.Identity.encode_public_key");
    expect(names).toContain("Arc.Identity.name");
    expect(names).toContain("Arc.Identity.short_name");
  });

  test("extracts call sites", async () => {
    const { tree, lang } = await pool.parse(FIXTURE, "elixir");
    const calls = extractCallSites(tree, lang, "elixir", FIXTURE, pool);
    tree.delete();

    const callees = calls.map((c) => c.callee_name);
    // String.trim is called inside normalize_input
    expect(callees).toContain("trim");
    // is_binary guard used in decode
    expect(callees).toContain("is_binary");
  });
});
