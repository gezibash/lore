#!/bin/sh
# Verify that a built lore binary runs and opens a database.
#
# `--version` and `--help` never touch SQLite. They pass even when the
# sqlite-vec extension fails to load, which is the failure this build risks on
# a machine that is not the build machine. This script runs `init` and
# `status` instead, because both open the database and load the extension.
#
# HOME points at a temporary directory. Lore keeps its network under
# $HOME/.lore, so the test leaves no state behind.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: smoke.sh <path-to-lore-binary>" >&2
  exit 2
fi

binary=$(cd "$(dirname "$1")" && pwd)/$(basename "$1")

if [ ! -x "$binary" ]; then
  echo "smoke: $binary is not executable" >&2
  exit 1
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

mkdir -p "$work/project"
echo 'export const smoke = 1;' > "$work/project/smoke.ts"

export HOME="$work"
export LORE_DAEMON_DISABLE=1

echo "smoke: version"
"$binary" --version

echo "smoke: init"
(cd "$work/project" && "$binary" init . smoke)

echo "smoke: status"
(cd "$work/project" && "$binary" status)

echo "smoke: passed"
