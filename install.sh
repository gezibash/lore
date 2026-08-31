#!/bin/sh
# Install lore from a GitHub release.
#
#   curl -fsSL https://raw.githubusercontent.com/gezibash/lore/main/install.sh | sh
#
# Environment:
#   LORE_VERSION   Tag to install. Default: the latest release.
#   LORE_PREFIX    Install prefix. Default: $HOME/.local
#
# Options:
#   --uninstall    Remove the installed files and the command.
#
# The release holds one tarball for each platform. Each tarball holds the
# binary, its native libraries and the migrations. The three stay together,
# because the binary reads the libraries from the directory beside itself.
set -eu

REPO=gezibash/lore
PREFIX=${LORE_PREFIX:-$HOME/.local}
LIB_DIR=$PREFIX/lib/lore
BIN_LINK=$PREFIX/bin/lore

die() {
  echo "install: $*" >&2
  exit 1
}

need() {
  command -v "$1" >/dev/null 2>&1 || die "$1 is required but not installed"
}

# Remove a path only when it is a symlink. A real file at this path belongs to
# something else, so the script stops instead of deleting it.
unlink_command() {
  if [ -L "$BIN_LINK" ]; then
    rm -f "$BIN_LINK"
    return 0
  fi
  [ -e "$BIN_LINK" ] && die "$BIN_LINK exists and is not a symlink — remove it by hand"
  return 1
}

if [ "${1:-}" = "--uninstall" ]; then
  had_link=no
  unlink_command && had_link=yes
  had_lib=no
  [ -d "$LIB_DIR" ] && had_lib=yes
  rm -rf "$LIB_DIR"
  if [ "$had_link" = yes ] || [ "$had_lib" = yes ]; then
    echo "Removed $BIN_LINK and $LIB_DIR"
  else
    echo "Nothing installed here."
  fi
  exit 0
fi

need curl
need tar

case $(uname -s) in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported operating system: $(uname -s)" ;;
esac

case $(uname -m) in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

asset=lore-$os-$arch.tar.gz

# Check the destination before the download. The archive is large, and a
# blocked destination fails the same way after 100 MB as it does now.
if [ -e "$BIN_LINK" ] && [ ! -L "$BIN_LINK" ]; then
  die "$BIN_LINK exists and is not a symlink — remove it by hand"
fi

if [ -n "${LORE_VERSION:-}" ]; then
  base=https://github.com/$REPO/releases/download/$LORE_VERSION
  label=$LORE_VERSION
else
  base=https://github.com/$REPO/releases/latest/download
  label=latest
fi

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT INT TERM

echo "Downloading $asset ($label)"
curl -fsSL --retry 3 -o "$work/$asset" "$base/$asset" ||
  die "no build for $os-$arch in release $label"

# The checksum file covers every asset in the release. A missing file means
# the release predates checksums, so the script stops rather than trust it.
echo "Verifying checksum"
curl -fsSL --retry 3 -o "$work/SHA256SUMS" "$base/SHA256SUMS" ||
  die "release $label publishes no SHA256SUMS"

if command -v sha256sum >/dev/null 2>&1; then
  sum=$(sha256sum "$work/$asset" | cut -d' ' -f1)
elif command -v shasum >/dev/null 2>&1; then
  sum=$(shasum -a 256 "$work/$asset" | cut -d' ' -f1)
else
  die "sha256sum or shasum is required to verify the download"
fi

want=$(grep " $asset\$" "$work/SHA256SUMS" | cut -d' ' -f1)
[ -n "$want" ] || die "SHA256SUMS lists no entry for $asset"
[ "$sum" = "$want" ] || die "checksum mismatch for $asset — expected $want, got $sum"

echo "Extracting"
mkdir -p "$work/dist"
tar -xzf "$work/$asset" -C "$work/dist"
[ -x "$work/dist/lore" ] || die "the archive holds no lore binary"

mkdir -p "$PREFIX/bin" "$PREFIX/lib"
rm -rf "$LIB_DIR"
cp -R "$work/dist" "$LIB_DIR"
unlink_command || true
ln -s "$LIB_DIR/lore" "$BIN_LINK"

echo
echo "Installed $LIB_DIR"
echo "Linked    $BIN_LINK"

# An earlier PATH entry wins silently. Name the shadow instead.
found=$(command -v lore 2>/dev/null || true)
if [ -z "$found" ]; then
  echo
  echo "Warning: $PREFIX/bin is not on PATH, so 'lore' will not resolve."
  echo "Add it:  export PATH=\"$PREFIX/bin:\$PATH\""
elif [ "$found" != "$BIN_LINK" ]; then
  echo
  echo "Warning: $found comes first on PATH and shadows $BIN_LINK."
else
  echo
  "$BIN_LINK" --version
fi
