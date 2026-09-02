#!/usr/bin/env bash
# Run the runtime in the container image with this checkout's compiled code mounted
# in, so an edit restarts the server without an image rebuild.
#
# The image ships production dependencies only, so `tsc --watch` runs here on the
# host and the container runs `node --watch` on the emitted `dist/`. The web bundle is
# rebuilt on change the same way, so the page and the runtime never run different
# versions of their shared wire format. The repo's `.env` is mounted where the runtime
# reads it; the database and data dir live in a named volume. The container is removed
# when this script exits, however it exits.
#
#   PRISM_IMAGE      image to run          (default ghcr.io/lensapp/prism-agent:canary)
#   PRISM_PORT       host port for :3003   (default 3003)
#   PRISM_CONTAINER  container name        (default prism-dev)
#   PRISM_VOLUME     named volume for /data (default prism-dev-data)
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel)"
cd "$REPO_ROOT"

IMAGE="${PRISM_IMAGE:-ghcr.io/lensapp/prism-agent:canary}"
PORT="${PRISM_PORT:-3003}"
NAME="${PRISM_CONTAINER:-prism-dev}"
VOLUME="${PRISM_VOLUME:-prism-dev-data}"

if [ ! -f .env ]; then
  echo "No .env in $REPO_ROOT. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

WATCH_PIDS=""
cleanup() {
  # `npx` wraps each watcher in an npm process, so the child goes first and the wrapper after.
  for pid in $WATCH_PIDS; do
    pkill -TERM -P "$pid" 2>/dev/null || true
    kill -TERM "$pid" 2>/dev/null || true
  done
  docker rm -f "$NAME" > /dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

# The image supplies node_modules and the generated Prisma client, nothing else of the
# code, so both have to match this checkout. A stale image fails at boot with a
# missing module, or at the first query for a column its client does not know.
image_differs() {
  ! docker run --rm --entrypoint cat "$IMAGE" "/app/$1" 2>/dev/null | cmp -s - "$1"
}
if image_differs package-lock.json || image_differs prisma/sqlite/schema.prisma; then
  echo "Warning: $IMAGE was built from a different package-lock.json or Prisma schema than this checkout." >&2
  echo "         Pull a newer image, or build one with 'npm run docker:build' and set PRISM_IMAGE=prism-agent:local." >&2
fi

echo "Compiling src/ to dist/ and the web UI to web/dist/..."
npx tsc
npm run build:web

npx tsc --watch --preserveWatchOutput &
WATCH_PIDS="$!"
# Rebuilds web/dist on change; the container serves it from the mount, so a reload of
# the page picks the new bundle up. Use 'npm run dev:web' instead for hot reload.
(cd web && npx vite build --watch --logLevel warn) &
WATCH_PIDS="$WATCH_PIDS $!"

TTY_FLAGS=""
if [ -t 0 ]; then TTY_FLAGS="-it"; fi

echo "Starting $IMAGE as $NAME on http://localhost:$PORT (Ctrl+C stops and removes it)"
# shellcheck disable=SC2086 # TTY_FLAGS is empty or -it, never a path.
docker run --rm $TTY_FLAGS --name "$NAME" \
  -p "$PORT:3003" \
  -e DATABASE_URL=file:/data/agent.db \
  -e PRISM_DATA_DIR=/data \
  -e PORT=3003 \
  -v "$VOLUME:/data" \
  -v "$REPO_ROOT/.env:/app/.env:ro" \
  -v "$REPO_ROOT/prisma:/app/prisma:ro" \
  -v "$REPO_ROOT/dist:/app/dist:ro" \
  -v "$REPO_ROOT/web/dist:/app/web/dist:ro" \
  "$IMAGE" \
  sh -c 'node dist/scripts/apply-pending-import.js && /app/node_modules/.bin/prisma migrate deploy --schema=prisma/sqlite/schema.prisma && exec node --watch dist/index.js'
