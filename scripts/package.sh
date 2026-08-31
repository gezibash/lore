#!/bin/sh
# Pack dist/ into one tarball for a release asset.
#
# The tarball holds the binary, lib/ and migrations/ together. The binary
# finds its native libraries beside itself, so the three must stay together.
set -eu

if [ $# -ne 1 ]; then
  echo "usage: package.sh <target-triple>" >&2
  exit 2
fi

target=$1
root=$(cd "$(dirname "$0")/.." && pwd)
dist=$root/dist
out=$root/dist-archive

if [ ! -x "$dist/lore" ]; then
  echo "package: $dist/lore is missing — run 'bun run build' first" >&2
  exit 1
fi

mkdir -p "$out"
archive=$out/lore-$target.tar.gz

# --numeric-owner and a fixed mtime keep the archive reproducible.
tar --numeric-owner -czf "$archive" -C "$dist" .

echo "$archive"
du -h "$archive" | cut -f1
