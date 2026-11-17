#!/bin/sh
# Agent Runtime startup orchestrator (invoked via `CMD ["./start.sh"]`).
#
# Responsibilities:
#   1. Default DATABASE_URL BEFORE the prisma CLI runs. Node's
#      `src/config.ts` has the same default but it loads after
#      `prisma migrate deploy`, which finds no database URL when the
#      operator doesn't pre-set it. Mirrors the runtime default so
#      an unconfigured `docker run` still works.
#   2. Hand the sandbox's TLS-interception CAs to Chromium as managed
#      enterprise policy — the browser cannot see them any other way.
#      No-op outside a sandbox.
#   3. Apply Prisma migrations.
#   4. Apply any pending `.prism` import via
#      `dist/scripts/apply-pending-import.js` BEFORE prisma migrate
#      deploy / server open the SQLite file. Shared with the
#      `dev:single` npm script (which runs the same code via tsx) —
#      single source of truth for the swap, no race with
#      `prisma migrate deploy` opening the stale DB.
#   5. Exec the Node server as PID 1 (after the migrate step so signal
#      handling + crash semantics match a clean process tree). The server
#      runs the embedding backfill itself, so this script forks nothing
#      that outlives it.
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
# What to hand over is whatever the live bundle holds that the image did not ship,
# compared by content against the record the build left in $CA_BASE. Identity rather
# than position, so a bundle that gets reordered or regenerated cannot make public
# roots look like the difference. The bundle path is the system bundle, where a sandbox
# supervisor appends its CAs.
CA_BUNDLE=/etc/ssl/certs/ca-certificates.crt
CA_BASE=/app/.ca-certificates.base
POLICY_DIRS='/etc/chromium/policies/managed /etc/opt/chrome/policies/managed'

# This boot either writes a policy or leaves none behind. The sandbox mints one of
# these CAs per container start, so a file from an earlier boot names an anchor whose
# key is gone, and the policy directories survive a restart in the writable layer.
drop_policy() {
  for policy_dir in $POLICY_DIRS; do
    rm -f "$policy_dir/prism-ca.json" 2>/dev/null || true
  done
}

# An empty $CA_BASE would make every certificate in the bundle look added, so it is
# tested for content and not merely for existence.
if [ ! -r "$CA_BUNDLE" ] || [ ! -s "$CA_BASE" ]; then
  drop_policy
  echo "chromium CA policy: skipped, need $CA_BUNDLE and a non-empty $CA_BASE; left no policy" >&2
else
  added=$(awk '
    /BEGIN CERTIFICATE/ { in_cert = 1; b64 = ""; next }
    /END CERTIFICATE/   { in_cert = 0; print b64; next }
    in_cert             { sub(/\r$/, ""); b64 = b64 $0 }
  ' "$CA_BUNDLE" | grep -Fxv -f "$CA_BASE" | awk '!seen[$0]++') || added=''

  count=0
  [ -z "$added" ] || count=$(printf '%s\n' "$added" | wc -l | tr -d ' ')

  if [ "$count" -eq 0 ]; then
    drop_policy
    echo 'chromium CA policy: bundle holds only what the image shipped, left no policy'
  elif [ "$count" -gt 10 ]; then
    # A first boot adds three: the two the server pushes and one the sandbox mints.
    # The mint is per container start and the supervisor tracks what it installed in
    # memory only, so a restart in place appends another, and the ceiling has to sit
    # above three to leave room for that. Well above it is a different matter: the
    # certificates on offer would then be public roots, and installing those as local
    # anchors is the outcome comparing by content exists to prevent.
    drop_policy
    echo "chromium CA policy: refusing $count added certificates, expected a handful; left no policy" >&2
  else
    entries=$(printf '%s\n' "$added" | awk '{ printf "%s\"%s\"", (NR > 1 ? "," : ""), $0 }')
    written=''
    for policy_dir in $POLICY_DIRS; do
      if [ ! -w "$policy_dir" ]; then
        echo "chromium CA policy: skipped $policy_dir, not writable" >&2
      elif printf '{"CACertificates":[%s]}' "$entries" > "$policy_dir/prism-ca.json"; then
        written="$written $policy_dir/prism-ca.json"
      else
        echo "chromium CA policy: failed writing $policy_dir/prism-ca.json" >&2
      fi
    done
    if [ -n "$written" ]; then
      echo "chromium CA policy: trusting $count added CA(s) via$written"
    fi
  fi
fi

node dist/scripts/apply-pending-import.js
"$PRISMA" migrate deploy --schema=prisma/sqlite/schema.prisma

exec node dist/index.js
