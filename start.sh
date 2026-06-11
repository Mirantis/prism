#!/bin/sh
# Agent Runtime startup orchestrator (invoked via `CMD ["./start.sh"]`).
#
# Responsibilities:
#   1. Default DATABASE_URL BEFORE the prisma CLI runs. Node's
#      `src/config.ts` has the same default but it loads after
#      `prisma migrate deploy`, so we'd get a confusing
#      `Environment variable not found: DATABASE_URL` from prisma if
#      the operator doesn't pre-set it. Mirrors the runtime default so
#      an unconfigured `docker run` still works.
#   2. Apply Prisma migrations.
#   3. Apply any pending `.prism` import via
#      `dist/scripts/apply-pending-import.js` BEFORE prisma migrate
#      deploy / backfill / server open the SQLite file. Shared with the
#      `dev:single` npm script (which runs the same code via tsx) —
#      single source of truth for the swap, no race with the backfill
#      subprocess step 4 forks, no race with `prisma migrate deploy`
#      opening the stale DB.
#   4. Kick off the embedding backfill in the background — best-effort,
#      never blocks startup.
#   5. Exec the Node server as PID 1 (after the migrate step so signal
#      handling + crash semantics match a clean process tree).
#
# Direct path to the workspace-hoisted prisma binary — avoids `npx`'s
# startup registry round-trip.

set -e

PRISMA=/app/node_modules/.bin/prisma

: "${DATABASE_URL:=file:/data/agent.db}"
export DATABASE_URL

# An operator-provided env var — even an empty one — takes precedence.
if [ -z "${OTEL_EXPORTER_OTLP_API_KEY+x}" ] && [ -s /app/.otel-api-key ]; then
  OTEL_EXPORTER_OTLP_API_KEY=$(cat /app/.otel-api-key)
  export OTEL_EXPORTER_OTLP_API_KEY
fi
node dist/scripts/apply-pending-import.js
"$PRISMA" migrate deploy --schema=prisma/sqlite/schema.prisma

(node dist/scripts/backfill-embeddings.js || \
  echo 'backfill-embeddings failed; continuing startup' >&2) &

exec node dist/index.js
