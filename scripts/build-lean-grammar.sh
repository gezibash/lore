#!/usr/bin/env bash
# Rebuild packages/core/grammars/tree-sitter-lean.wasm.
#
# Every other grammar comes from a package: @repomix/tree-sitter-wasms serves
# six, and tree-sitter-elixir serves its own. Lean has no such package. The
# grammar is a GitHub repository with no npm release and no tagged wasm, so
# lore carries the built artifact in the repository.
#
# The artifact is committed. This script exists to reproduce it, not to run
# during a build or an install. Commit 3458641 built the Elixir wasm by hand
# and kept it only in one node_modules, which made Elixir parsing dead on
# every fresh install (issue #21). A committed artifact plus this script
# prevents that failure.
#
# The grammar is upstream plus the patches this repository holds. The script
# clones the pinned upstream commit, applies every patch in
# patches/tree-sitter-lean, regenerates the parser, and builds the wasm. It
# does NOT build unmodified upstream.
#
# Patches live here rather than in a lore-owned fork for two reasons. The
# patch is reviewed in the same diff as the code that needs it, and there is
# no second repository to keep alive. To move the pin, change the commit
# below and run the script: `git apply` fails loudly if a patch no longer
# applies, which is the signal to look at upstream.
#
# Requirements: git, curl, node, and Docker or Emscripten. tree-sitter reads
# grammar.js with a JavaScript runtime, and it uses Docker when emcc is absent.
# To build without node, add `--js-runtime native` to the generate step: the
# CLI carries QuickJS.
#
# The generate step is slow and memory-hungry: 12 minutes and 60 GB of RAM at
# peak, measured on an M-series Mac. The Lean grammar builds a large LR table.
# A machine with less RAM than that will swap.
#
# Usage:
#   scripts/build-lean-grammar.sh            # build the pinned commit
#   scripts/build-lean-grammar.sh <commit>   # build a different commit
set -euo pipefail

GRAMMAR_REPO="https://github.com/Julian/tree-sitter-lean.git"
# Pinned. An unpinned build makes the artifact irreproducible, and the grammar
# is experimental, so its node names can change between commits. To move the
# pin, change this value, run the script, then run the Lean parser tests.
GRAMMAR_COMMIT="${1:-86c2bcb379fe0b2ad13d8b3411400deff75b2785}"
PATCH_DIR="patches/tree-sitter-lean"
TREE_SITTER_VERSION="0.26.6"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$REPO_ROOT/packages/core/grammars/tree-sitter-lean.wasm"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

case "$(uname -s)-$(uname -m)" in
  Darwin-arm64) CLI_ASSET="tree-sitter-macos-arm64.gz" ;;
  Darwin-x86_64) CLI_ASSET="tree-sitter-macos-x64.gz" ;;
  Linux-aarch64) CLI_ASSET="tree-sitter-linux-arm64.gz" ;;
  Linux-x86_64) CLI_ASSET="tree-sitter-linux-x64.gz" ;;
  *) echo "Unsupported platform: $(uname -s)-$(uname -m)" >&2; exit 1 ;;
esac

echo "==> Downloading tree-sitter $TREE_SITTER_VERSION"
curl -fsSL -o "$WORK/ts.gz" \
  "https://github.com/tree-sitter/tree-sitter/releases/download/v${TREE_SITTER_VERSION}/${CLI_ASSET}"
gunzip "$WORK/ts.gz"
chmod +x "$WORK/ts"

echo "==> Cloning the grammar at $GRAMMAR_COMMIT"
git clone --quiet "$GRAMMAR_REPO" "$WORK/grammar"
git -C "$WORK/grammar" checkout --quiet "$GRAMMAR_COMMIT"

echo "==> Applying $PATCH_DIR"
for patch in "$REPO_ROOT/$PATCH_DIR"/*.patch; do
  echo "    $(basename "$patch")"
  git -C "$WORK/grammar" apply "$patch"
done

echo "==> Generating the parser"
# The patches change grammar.js, so the committed src/parser.c is stale.
# This step takes 12 minutes and 60 GB of RAM at peak.
(cd "$WORK/grammar" && "$WORK/ts" generate)

echo "==> Building the wasm"
# The build runs in the grammar directory: tree-sitter reads src/parser.c and
# src/scanner.c from the working directory.
(cd "$WORK/grammar" && "$WORK/ts" build --wasm .)

mkdir -p "$(dirname "$DEST")"
cp "$WORK/grammar/tree-sitter-lean.wasm" "$DEST"

SUM="$(shasum -a 256 "$DEST" | cut -d' ' -f1)"
# The hash is tracked. CI compares the committed wasm against it, so a patch
# that is edited and never rebuilt fails the build instead of passing quietly
# against a stale binary.
echo "$SUM" > "$REPO_ROOT/$PATCH_DIR/wasm.sha256"

echo "==> Wrote $DEST"
echo "    commit $GRAMMAR_COMMIT plus $PATCH_DIR"
echo "    $(wc -c < "$DEST" | tr -d ' ') bytes"
echo "    sha256 $SUM"
