# Languages and symbol extraction

Lore extracts symbols from these languages:

| Language   | Extensions                 | Symbols                                                                               |
| ---------- | -------------------------- | ------------------------------------------------------------------------------------- |
| TypeScript | `.ts` `.tsx`               | function, class, method, interface, type, enum, constant                              |
| JavaScript | `.js` `.jsx` `.mjs` `.cjs` | function, class, method, constant                                                     |
| Python     | `.py`                      | function, class, constant                                                             |
| Go         | `.go`                      | function, method, struct, interface                                                   |
| Rust       | `.rs`                      | function, struct, enum, trait, impl                                                   |
| Elixir     | `.ex` `.exs`               | function, module, protocol                                                            |
| Lean 4     | `.lean`                    | theorem, def, abbrev, structure, inductive, instance, axiom, opaque, constant, syntax |

A file in another language is still indexed and still answers a `lore ask`.
Lore reads it as text, so it has no symbols. Three features need symbols:
`lore bind`, `lore ask --mode code`, and `lore sys coverage`.

Lean gets its own symbol kind for a theorem, separate from a function. A
theorem states a fact, and the proof is only the body, so `lore show` marks
which bindings of a concept are claims and which are definitions.

Lean also gets a symbol kind for syntax. `syntax`, `macro`, `elab`, `notation`
and `declare_syntax_cat` add a way to write something, not a value to compute,
so a search for a tactic does not return every definition beside it.

A tactic is named by the token that calls it. `syntax "ring_nf" : tactic`
declares no identifier, and Lean generates one, but a proof writes `ring_nf`,
so `ring_nf` is the name lore stores. A command that writes `(name := ringNF)`
declares the identifier itself, and lore stores that instead.

Lore reads a Lean namespace as part of the name, and binds
`Auth.Token.refresh`, not `refresh`. A section bounds variables and not names,
so it changes no name. A token, a syntax category and an option name are
different: Lean registers each one as written, so a namespace does not qualify
them.

`macro_rules` and `elab_rules` add cases to a syntax that another command
declared. Neither introduces a name, so neither becomes a symbol.

No package publishes a Lean grammar, so lore carries the built parser at
`packages/core/grammars/tree-sitter-lean.wasm`. To rebuild it, run
`scripts/build-lean-grammar.sh`. The script pins the upstream commit, applies
the patches in `patches/tree-sitter-lean`, and needs Docker or Emscripten.

The patch is lore's, not upstream's. Upstream models `elab_rules` and has no
`elab` rule, so an `elab` block became a parse error that also swallowed the
declarations after it.

The Lean grammar is experimental, and it reads mathematics better than it
reads metaprogramming.

The tables below count a declaration as found when a symbol covers the row
that opens it, and no other declaration opens between that symbol's first row
and this one. An anonymous instance is out of the count, because lore skips it
by design. This rule is stricter than the one lore used before it: it does not
credit a declaration to the symbol above it, so its numbers are lower for the
same parser and are not comparable to any earlier figure.

On the `batteries` library, 258 files:

| Content                        | Declarations found |
| ------------------------------ | ------------------ |
| Theorems                       | 98%                |
| Mathematical definitions       | 84%                |
| Tactics, elaborators, notation | 46%                |

On `Mathlib/Tactic`, 366 files that exist to extend Lean:

| Content                        | Declarations found |
| ------------------------------ | ------------------ |
| Theorems                       | 83%                |
| Mathematical definitions       | 49%                |
| Tactics, elaborators, notation | 28%                |

A tactic file uses `do` notation and syntax quotations, and the parser stops
early in them. Three quarters of the rows in `Mathlib/Tactic` sit inside a
parse error, and no query reaches a declaration in one. `do` notation is the
part the grammar reads least well. `return`, `for`, `unless` and a `let` that
binds by matching have no rule, and each one ends the command it sits in.

Lore never fails a file: it returns the declarations it read and skips the
rest. Across all 9021 files of Mathlib, no file crashed the parser. Expect
full results for a file of theorems and definitions, and gaps in a file that
extends Lean itself.
