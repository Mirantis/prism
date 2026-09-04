#!/bin/sh
# Build step: install Lens Desktop from its GitHub release into the image, with the launcher
# and the menu entry that starts Lens through it.
#
# Lens ships arm64 builds only as release assets of lensapp/lens-desktop-monorepo, an
# internal repository, so the download needs a token that can read it. The token comes
# from the `github_token` build secret. Without one, or when the release has no package
# for this architecture, the image is built without Lens, and without the launcher and the
# menu entry, so that nothing on the desktop points at a program that is not there.
#
# The launcher and the entry go in after the package: the package installs a menu entry of
# the same name that starts Lens without the flags a container needs.
#
# Usage: install-lens.sh <release tag> <debian architecture> <dir with lens-launcher.sh and lens.desktop>
set -eu

VERSION="$1"
ARCH="$2"
FILES="$3"
REPO=lensapp/lens-desktop-monorepo
ASSET="Lens-${VERSION}.${ARCH}.deb"
TOKEN="$(cat /run/secrets/github_token 2>/dev/null || true)"

without_lens() {
  echo "Lens Desktop: $1; building without it"
  exit 0
}

[ -n "$TOKEN" ] || without_lens "no github_token build secret"

# A release asset of a private repository downloads through its API URL, found by name.
ASSET_URL="$(curl -fsSL -H "Authorization: Bearer $TOKEN" \
    "https://api.github.com/repos/${REPO}/releases/tags/${VERSION}" \
  | python3 -c 'import json, sys
name = sys.argv[1]
print(next((a["url"] for a in json.load(sys.stdin)["assets"] if a["name"] == name), ""))' "$ASSET" \
  || true)"
[ -n "$ASSET_URL" ] || without_lens "release ${VERSION} has no ${ASSET}"

curl -fsSL -H "Authorization: Bearer $TOKEN" -H "Accept: application/octet-stream" \
  -o /tmp/lens.deb "$ASSET_URL"
apt-get update
apt-get install -y --no-install-recommends /tmp/lens.deb
rm -rf /var/lib/apt/lists/* /tmp/lens.deb
install -m 0755 "$FILES/lens-launcher.sh" /usr/local/bin/lens
install -m 0644 "$FILES/lens.desktop" /usr/share/applications/lens-desktop.desktop
echo "Lens Desktop: installed ${ASSET}"
