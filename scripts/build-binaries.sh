#!/usr/bin/env bash
#
# Build the distributable `prism` (the terminal UI) and `prism-server` (the
# runtime) binaries, both Rust, for the host platform and (unless SKIP_ARCHIVE is
# set) package an archive ready for the GitHub Releases upload.
# `.github/workflows/create-binary.yml` wraps this script so the build pipeline
# lives in one place.
#
# Env:
#   VERSION        version string used in the archive filename (default: dev)
#   SKIP_SMOKE     skip scripts/smoke-binaries.mjs when non-empty
#   SKIP_ARCHIVE   stop before packaging (no tar/zip) when non-empty
#
# Output:
#   dist-sea/<plat>-<arch>/                prism, prism-server, web/, node_modules/ (placeholder),
#                                          LICENSE, NOTICE, THIRD_PARTY_NOTICES, install.sh
#                                          (macOS/Linux) or install.ps1 (Windows)
#   prism-<version>-<plat>-<arch>.tar.gz   (macOS/Linux)
#   prism-<version>-<plat>-<arch>.zip      (Windows, via 7z)
#
# Assumes dependencies are already installed (`npm ci` first) and a Rust
# toolchain is on PATH.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

VERSION="${VERSION:-dev}"

OS_ARCH=$(node -e 'process.stdout.write(`${process.platform}-${process.arch}`)')
PLATFORM=$(node -e 'process.stdout.write(process.platform)')

npm run build:web

# Both binaries report this version (`--version`), and the runtime, because it is
# set, applies the standalone install's defaults. A non-release VERSION builds
# as the package version.
if [[ "$VERSION" =~ ^v[0-9]{4}\.[0-9]{1,2}\.[0-9]+$ ]]; then
  PRISM_VERSION="$VERSION"
else
  PRISM_VERSION=$(node -p 'require("./package.json").version')
fi
PRISM_VERSION="$PRISM_VERSION" cargo build --release --locked --manifest-path backend/Cargo.toml --bin prism-server
PRISM_VERSION="$PRISM_VERSION" cargo build --release --locked --manifest-path cli/Cargo.toml --bin prism
EXE=""
[ "$PLATFORM" = "win32" ] && EXE=".exe"
mkdir -p "dist-sea/$OS_ARCH"
cp "backend/target/release/prism-server$EXE" "dist-sea/$OS_ARCH/prism-server$EXE"
cp "cli/target/release/prism$EXE" "dist-sea/$OS_ARCH/prism$EXE"
rm -rf "dist-sea/$OS_ARCH/web"
cp -R web/dist "dist-sea/$OS_ARCH/web"

# The updater in a TypeScript-runtime install refuses an archive without
# node_modules/ and swaps that directory in, so the archive keeps a placeholder
# for those installs to update. The installers and the Rust updater copy only
# the entries they name, and the Rust updater moves an install's node_modules/
# to the update trash.
rm -rf "dist-sea/$OS_ARCH/node_modules"
mkdir -p "dist-sea/$OS_ARCH/node_modules"
echo "Prism needs nothing in this directory. Releases keep it so an older install can update." \
  > "dist-sea/$OS_ARCH/node_modules/README.txt"

# License, attribution and third-party notices ship inside the archive, and
# install.sh / install.ps1 copy them into $PRISM_HOME. This runs before the smoke
# test, which checks all three are in dist-sea/.
cp LICENSE NOTICE THIRD_PARTY_NOTICES "dist-sea/$OS_ARCH/"

if [ -z "${SKIP_SMOKE:-}" ]; then
  node scripts/smoke-binaries.mjs
fi

if [ -n "${SKIP_ARCHIVE:-}" ]; then
  exit 0
fi

# Ship the platform-appropriate installer inside the archive so users can run
# it directly: install.ps1 on Windows, install.sh on macOS/Linux.
if [ "$PLATFORM" = "win32" ]; then
  cp install.ps1 "dist-sea/$OS_ARCH/install.ps1"
else
  cp install.sh "dist-sea/$OS_ARCH/install.sh"
fi

cd dist-sea
if [ "$PLATFORM" = "win32" ]; then
  NAME="prism-$VERSION-$OS_ARCH.zip"
  7z a -tzip "../$NAME" "$OS_ARCH" >/dev/null
else
  NAME="prism-$VERSION-$OS_ARCH.tar.gz"
  tar -czf "../$NAME" "$OS_ARCH"
fi
cd ..

# Checksum next to the archive — the updater verifies the download against it.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum "$NAME" > "$NAME.sha256"
else
  shasum -a 256 "$NAME" > "$NAME.sha256"
fi
echo "Built: $NAME"
