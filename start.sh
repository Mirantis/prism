#!/bin/sh
# Agent Runtime startup orchestrator.
#
# Single source of truth for boot logic, invoked by both Dockerfiles:
#   - Dockerfile sets `CMD ["./start.sh"]`
#   - Dockerfile.nexus-sandbox sets `ENV AGENT_COMMAND="./start.sh"`
#
# Responsibilities:
#   1. Default DATABASE_URL in single-agent mode BEFORE the prisma CLI
#      runs. Node's `src/config.ts` has the same default but it loads
#      after `prisma migrate deploy`, so we'd get a confusing
#      `Environment variable not found: DATABASE_URL` from prisma if
#      the operator doesn't pre-set it. Mirrors the runtime default
#      so an unconfigured `docker run … -e SINGLE_AGENT_MODE=true` still
#      works.
#   2. Apply Prisma migrations against the right schema for the mode.
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
# startup call to registry.npmjs.org, which the Nexus sandbox proxy
# (default_action=Deny) rejects.

set -e

PRISMA=/app/node_modules/.bin/prisma

if [ "$SINGLE_AGENT_MODE" = "1" ] || [ "$SINGLE_AGENT_MODE" = "true" ]; then
  : "${DATABASE_URL:=file:/data/agent.db}"
  export DATABASE_URL
  node dist/scripts/apply-pending-import.js
  "$PRISMA" migrate deploy --schema=prisma/sqlite/schema.prisma
else
  "$PRISMA" migrate deploy
fi

(node dist/scripts/backfill-embeddings.js || \
  echo 'backfill-embeddings failed; continuing startup' >&2) &

exec node dist/index.js
