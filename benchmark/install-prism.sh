#!/usr/bin/env bash
#
# Install prism-server inside a Harbor task sandbox.
#
# Deliberately NOT the repo-root install.sh: that one registers the runtime with
# launchd/systemd, and a task container has neither, so `systemctl --user` fails
# and takes the whole install down with it. This script does the same download
# and unpack, then stops — run-prism.sh owns the process lifecycle instead.
#
# Usage: install-prism.sh [<release-tag>|latest]
set -euo pipefail

TAG="${1:-latest}"
PRISM_HOME="${PRISM_HOME:-/opt/prism}"
REPO="${PRISM_REPO:-lensapp/prism-agent}"

# Task images vary; several ship neither curl nor tar. Install what is missing
# before assuming either exists.
need_pkg=false
for cmd in curl tar; do
  command -v "$cmd" >/dev/null 2>&1 || need_pkg=true
done
if [ "$need_pkg" = true ]; then
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y curl ca-certificates tar
  elif command -v apk >/dev/null 2>&1; then
    apk add --no-cache curl ca-certificates tar
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y curl ca-certificates tar
  elif command -v yum >/dev/null 2>&1; then
    yum install -y curl ca-certificates tar
  else
    echo "curl/tar missing and no supported package manager found" >&2
    exit 127
  fi
fi
command -v curl >/dev/null
command -v tar >/dev/null

case "$(uname -s)" in
  Linux) plat=linux ;;
  *) echo "Unsupported OS $(uname -s) — Harbor sandboxes are Linux." >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64|amd64) arch=x64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) echo "Unsupported arch $(uname -m)" >&2; exit 1 ;;
esac

if [ "$TAG" = "latest" ]; then
  # Resolved with grep/sed rather than jq: jq is absent from many task images,
  # and this is a single well-known field.
  TAG=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/.*"([^"]+)"$/\1/' \
        | head -n1)
  [ -n "$TAG" ] || { echo "Could not resolve the latest release of ${REPO}" >&2; exit 1; }
fi

ARCHIVE="prism-${TAG}-${plat}-${arch}.tar.gz"
URL="https://github.com/${REPO}/releases/download/${TAG}/${ARCHIVE}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo "Downloading ${ARCHIVE}"
curl -fsSL -o "$TMP/$ARCHIVE" "$URL"
tar -xzf "$TMP/$ARCHIVE" -C "$TMP"

DIST="$TMP/${plat}-${arch}"
[ -x "$DIST/prism-server" ] || { echo "Archive has no ${plat}-${arch}/prism-server" >&2; exit 1; }

# node_modules/ carries the native addons the SEA bundle keeps external
# (better-sqlite3, sqlite-vec, @prisma/client); web/ is the bundled SPA. The
# binary resolves both relative to its own directory, so they travel together.
rm -rf "$PRISM_HOME"
mkdir -p "$PRISM_HOME"
cp "$DIST/prism-server" "$PRISM_HOME/prism-server"
chmod +x "$PRISM_HOME/prism-server"
cp -R "$DIST/node_modules" "$PRISM_HOME/node_modules"
[ -d "$DIST/web" ] && cp -R "$DIST/web" "$PRISM_HOME/web"

# Records the tag for the adapter's version reporting, and doubles as the
# install marker the adapter checks to skip a redundant download.
printf '%s\n' "$TAG" > "$PRISM_HOME/VERSION"
echo "Installed prism-server ${TAG} into ${PRISM_HOME}"
