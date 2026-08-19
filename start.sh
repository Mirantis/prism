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
#   2. Hand the sandbox's TLS-interception CAs to Chromium as managed
#      enterprise policy — the browser cannot see them any other way.
#      No-op outside a sandbox.
#   3. Apply Prisma migrations.
#   4. Apply any pending `.prism` import via
#      `dist/scripts/apply-pending-import.js` BEFORE prisma migrate
#      deploy / backfill / server open the SQLite file. Shared with the
#      `dev:single` npm script (which runs the same code via tsx) —
#      single source of truth for the swap, no race with the backfill
#      subprocess step 5 forks, no race with `prisma migrate deploy`
#      opening the stale DB.
#   5. Kick off the embedding backfill in the background — best-effort,
#      never blocks startup.
#   6. Exec the Node server as PID 1 (after the migrate step so signal
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

# Enable Chromium to trust the sandbox's TLS-intercepting CAs.
#
# A sandbox terminates TLS at its boundary proxy and appends its CAs to the
# system bundle. Chromium ignores that bundle; its only admin-facing hook is a
# managed enterprise policy, without which it rejects every proxied origin
# (`ERR_CERT_AUTHORITY_INVALID`).
#
# The base64 must be one unbroken line per certificate. A PEM body is already
# base64 DER, so awk strips the armor and joins the wrapped lines.
# CACertificates needs M132+; Debian's chromium is far past that.
#
# The bundle path is the one lens-sandbox-core hardcodes.
CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
CA_COUNT=/app/.ca-cert-count
if [ -z "${SSL_CERT_FILE:-}" ]; then
  echo 'chromium CA policy: not in a sandbox (SSL_CERT_FILE unset), nothing to trust'
elif [ ! -r "$CA_BUNDLE" ] || [ ! -r "$CA_COUNT" ]; then
  echo "chromium CA policy: skipped, need both $CA_BUNDLE and $CA_COUNT" >&2
else
  sandbox_cas=$(awk -v skip="$(cat "$CA_COUNT")" '
    /BEGIN CERTIFICATE/ { in_cert = 1; b64 = ""; next }
    /END CERTIFICATE/   { in_cert = 0
                          if (++seen > skip) printf "%s\"%s\"", (n++ ? "," : ""), b64
                          next }
    in_cert             { b64 = b64 $0 }
  ' "$CA_BUNDLE") || sandbox_cas=''

  if [ -z "$sandbox_cas" ]; then
    echo "chromium CA policy: skipped, no CAs appended past the $(cat "$CA_COUNT") the image ships" >&2
  else
    written=''
    for policy_dir in /etc/chromium/policies/managed /etc/opt/chrome/policies/managed; do
      if [ ! -w "$policy_dir" ]; then
        echo "chromium CA policy: skipped $policy_dir, not writable" >&2
      elif printf '{"CACertificates":[%s]}' "$sandbox_cas" > "$policy_dir/prism-ca.json"; then
        written="$written $policy_dir/prism-ca.json"
      else
        echo "chromium CA policy: failed writing $policy_dir/prism-ca.json" >&2
      fi
    done
    if [ -n "$written" ]; then
      # base64 has no comma, so splitting on one counts the entries exactly.
      echo "chromium CA policy: trusting $(printf '%s\n' "$sandbox_cas" | tr ',' '\n' | wc -l | tr -d ' ') sandbox CA(s) via$written"
    fi
  fi
fi

node dist/scripts/apply-pending-import.js
"$PRISMA" migrate deploy --schema=prisma/sqlite/schema.prisma

(node dist/scripts/backfill-embeddings.js || \
  echo 'backfill-embeddings failed; continuing startup' >&2) &

exec node dist/index.js
