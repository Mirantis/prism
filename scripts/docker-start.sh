#!/bin/bash
# Run the built image the way a deployment runs it, with this checkout's `.env`.
#
# Nothing from the working tree but that file: the code, the web bundle and the Prisma
# client are the image's own, so this is the image as it would ship.
#
# The container is removed when it exits. The data volume is not: the agent's database,
# its skills and its browser profile outlive a restart, as they do in a deployment.
set -euo pipefail
cd "$(dirname "$0")/.."

IMAGE="${PRISM_IMAGE:-prism-agent:local}"
PORT="${PRISM_PORT:-3003}"
WEBHOOK_PORT="${PRISM_WEBHOOK_PORT:-3004}"
TEAMS_PORT="${PRISM_TEAMS_PORT:-3979}"
VOLUME="${PRISM_VOLUME:-prism-data}"

if ! docker image inspect "$IMAGE" > /dev/null 2>&1; then
  echo "No image $IMAGE. Build one with 'npm run docker:build'." >&2
  exit 1
fi

# One list, built up rather than several arrays: an empty array expanded under `set -u` is
# an error on the bash macOS ships, which is the shell this runs in most often.
ARGS=(--rm)
# A terminal gets a TTY, so Ctrl+C reaches the runtime and its logs are coloured. Asking
# for one where there is none — a pipeline, a CI step — is refused by docker outright.
if [ -t 0 ]; then ARGS+=(-it); fi
ARGS+=(-p "$PORT:3003" -p "$WEBHOOK_PORT:3004" -p "$TEAMS_PORT:3979")
if [ -f .env ]; then
  ARGS+=(-v "$PWD/.env:/app/.env:ro")
else
  echo "No .env in this checkout: the agent starts without a model provider or Slack." >&2
fi
ARGS+=(-v "$VOLUME:/data")

echo "Starting $IMAGE on http://localhost:$PORT — Ctrl+C stops it."
exec docker run "${ARGS[@]}" "$IMAGE"
