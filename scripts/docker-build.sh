#!/bin/bash
# Build the container image from this checkout as `prism-agent:local`.
#
# The image is what `npm run docker:start` and `npm run docker:dev` run, and the only way
# to try anything that needs its toolchain: the agent's desktop, its browser, OCR and the
# document skills all live in the image rather than on the host.
#
# Extra arguments go to `docker build`, so `--no-cache` and `--progress=plain` work as
# usual. Nothing here is specific to this machine; CI builds the same file.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${PRISM_IMAGE:-prism-agent:local}"

# mise resolves each tool through the GitHub API, which is rate-limited per IP for an
# anonymous caller and generous for an authenticated one. The token is passed as a build
# secret, so it is never written into a layer, and the build works without one.
SECRET=()
TOKEN_FILE="$(mktemp)"
trap 'rm -f "$TOKEN_FILE"' EXIT
if command -v gh > /dev/null 2>&1 && gh auth token > "$TOKEN_FILE" 2>/dev/null && [ -s "$TOKEN_FILE" ]; then
  SECRET=(--secret "id=github_token,src=$TOKEN_FILE")
fi

echo "Building $IMAGE..."
docker build --load -t "$IMAGE" -f Dockerfile "${SECRET[@]}" "$@" .
echo "Built $IMAGE. Run it with 'npm run docker:start'."
