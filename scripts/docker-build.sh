#!/bin/bash
# Build the image as prism-agent:local, handing the build the GitHub token `gh` holds so
# that it can install Lens Desktop from its internal release. Without `gh` or a login the
# build runs the same and leaves Lens out.
set -euo pipefail
cd "$(dirname "$0")/.."

SECRET=()
TOKEN_FILE="$(mktemp)"
trap 'rm -f "$TOKEN_FILE"' EXIT
if gh auth token > "$TOKEN_FILE" 2>/dev/null && [ -s "$TOKEN_FILE" ]; then
  SECRET=(--secret "id=github_token,src=$TOKEN_FILE")
else
  echo "no GitHub token from gh: building without Lens Desktop" >&2
fi

# Not exec: the trap above has to remove the token file once the build is done.
docker build --load -t prism-agent:local -f Dockerfile "${SECRET[@]}" "$@" .
