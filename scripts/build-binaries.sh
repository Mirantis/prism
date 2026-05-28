#!/usr/bin/env bash
#
# Build the distributable `prism` + `prism-server` SEA binaries for the host
# platform and (unless SKIP_ARCHIVE is set) package an archive ready for the
# GitHub Releases upload. `.github/workflows/create-binary.yml` wraps this
# script so the build pipeline lives in one place.
#
# Env:
#   VERSION        version string used in the archive filename (default: dev)
#   SKIP_SMOKE     skip scripts/smoke-sea.mjs when non-empty
#   SKIP_ARCHIVE   stop after collect-natives (no tar/zip) when non-empty
#
# Output:
#   dist-sea/<plat>-<arch>/                prism, prism-server, node_modules/,
#                                          web/, install.sh
#   prism-<version>-<plat>-<arch>.tar.gz   (macOS/Linux)
#   prism-<version>-<plat>-<arch>.zip      (Windows, via 7z)
#
# Assumes dependencies are already installed (`npm ci` first).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-dev}"

npm run build:web
node scripts/build-sea.mjs prism
node scripts/build-sea.mjs prism-server
node scripts/collect-natives.mjs

if [ -z "${SKIP_SMOKE:-}" ]; then
  node scripts/smoke-sea.mjs
fi

if [ -n "${SKIP_ARCHIVE:-}" ]; then
  exit 0
fi

OS_ARCH=$(node -e 'process.stdout.write(`${process.platform}-${process.arch}`)')
PLATFORM=$(node -e 'process.stdout.write(process.platform)')

# Ship install.sh inside the archive so users can run it directly.
cp install.sh "dist-sea/$OS_ARCH/install.sh"

cd dist-sea
if [ "$PLATFORM" = "win32" ]; then
  NAME="prism-$VERSION-$OS_ARCH.zip"
  7z a -tzip "../$NAME" "$OS_ARCH" >/dev/null
else
  NAME="prism-$VERSION-$OS_ARCH.tar.gz"
  tar -czf "../$NAME" "$OS_ARCH"
fi
echo "Built: $NAME"
