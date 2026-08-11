#!/usr/bin/env bash
#
# Drive one Harbor trial against prism-server, inside the task sandbox.
#
# Prism is a server, not a one-shot CLI: there is no `prism --prompt …` to exec.
# So a trial is start → wait for health → one synchronous chat turn → shut down.
# All of it runs in the sandbox so the runtime's shell tools operate on the
# task's own filesystem — `shell_exec` spawns children of prism-server, which
# means a server on the runner would edit the wrong machine.
#
# The chat request body is prepared on the runner and uploaded (PRISM_CHAT_BODY),
# because embedding a task instruction into JSON from shell would need escaping
# this script has no safe way to do.
#
# Env:
#   PRISM_CHAT_BODY          path to the prepared POST /agents/chat JSON  (required)
#   PRISM_HOME               install dir                                 (default /opt/prism)
#   PRISM_HTTP_URL           runtime base URL                            (default http://127.0.0.1:3003)
#   PRISM_BOOT_TIMEOUT       seconds to wait for /health                 (default 120)
#   PRISM_TURN_TIMEOUT       seconds to wait for the turn                (default 5400)
#   PRISM_DISABLE_AUTONOMY   'true' expected — no heartbeat/cron/goal turns  (warns otherwise)
#   SHELL_WORKSPACE_ROOT     agent cwd                                   (default: this script's cwd)
#   plus every var prism-server itself reads (AGENT_ID, LLM_PROVIDER, model id, credentials…)
set -uo pipefail

PRISM_HOME="${PRISM_HOME:-/opt/prism}"
PRISM_HTTP_URL="${PRISM_HTTP_URL:-http://127.0.0.1:3003}"
PRISM_BOOT_TIMEOUT="${PRISM_BOOT_TIMEOUT:-120}"
PRISM_TURN_TIMEOUT="${PRISM_TURN_TIMEOUT:-5400}"
SERVER_LOG="${PRISM_SERVER_LOG:-/logs/agent/prism-server.log}"

: "${PRISM_CHAT_BODY:?PRISM_CHAT_BODY must point at the prepared chat request body}"
[ -s "$PRISM_CHAT_BODY" ] || { echo "chat body $PRISM_CHAT_BODY is missing or empty" >&2; exit 1; }

# Harbor execs this in the task's working directory, so `pwd` is the directory
# the instruction talks about. Deriving the workspace from it keeps the agent
# and the task pointed at the same tree without the adapter having to know each
# task image's layout.
export SHELL_WORKSPACE_ROOT="${SHELL_WORKSPACE_ROOT:-$(pwd)}"
mkdir -p "$SHELL_WORKSPACE_ROOT" "$(dirname "$SERVER_LOG")"

# Keep the DB beside the install, not in the workspace: the grader inspects the
# task tree, and a stray agent.db there could fail a "no unexpected files" check.
export DATABASE_URL="${DATABASE_URL:-file:${PRISM_HOME}/agent.db}"
export PRISM_WEB_DIR="${PRISM_WEB_DIR:-${PRISM_HOME}/web}"

"$PRISM_HOME/prism-server" >>"$SERVER_LOG" 2>&1 &
SERVER_PID=$!

shutdown() {
  if kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null
    # Give the runtime a moment to close SQLite cleanly, then insist.
    for _ in $(seq 1 20); do
      kill -0 "$SERVER_PID" 2>/dev/null || return
      sleep 0.5
    done
    kill -9 "$SERVER_PID" 2>/dev/null
  fi
}
trap shutdown EXIT INT TERM

# --- wait for the runtime to be listening ------------------------------------
booted=false
deadline=$(( $(date +%s) + PRISM_BOOT_TIMEOUT ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "prism-server exited during startup; tail of ${SERVER_LOG}:" >&2
    tail -n 40 "$SERVER_LOG" >&2 || true
    exit 1
  fi
  if curl -fsS -o /dev/null "${PRISM_HTTP_URL}/health" 2>/dev/null; then
    booted=true
    break
  fi
  sleep 1
done
if [ "$booted" != true ]; then
  echo "prism-server did not answer /health within ${PRISM_BOOT_TIMEOUT}s; tail of ${SERVER_LOG}:" >&2
  tail -n 40 "$SERVER_LOG" >&2 || true
  exit 1
fi
echo "prism-server is up at ${PRISM_HTTP_URL} (workspace ${SHELL_WORKSPACE_ROOT})" >&2

# --- confirm nothing autonomous is running -----------------------------------
# The adapter sets PRISM_DISABLE_AUTONOMY=true so the runtime never starts a
# heartbeat timer, cron job, or goal loop. Warn rather than stop if it is missing:
# the trial can still be valid (the default heartbeat has no checks configured),
# but an autonomous turn editing the task tree mid-trial would invalidate it.
if [ "${PRISM_DISABLE_AUTONOMY:-}" != "true" ]; then
  echo "warning: PRISM_DISABLE_AUTONOMY is not 'true' — heartbeat/cron/goal turns may interleave with this trial" >&2
fi

# --- the turn ----------------------------------------------------------------
# One synchronous request. The turn can run for a long time at high effort, so
# --max-time carries the real budget rather than curl's default.
echo "dispatching the task instruction" >&2
http_status=$(
  curl -sS -o /tmp/prism-chat-response.json -w '%{http_code}' \
    --max-time "$PRISM_TURN_TIMEOUT" \
    -X POST "${PRISM_HTTP_URL}/agents/chat" \
    -H 'Content-Type: application/json' \
    --data-binary "@${PRISM_CHAT_BODY}"
)
curl_status=$?

if [ "$curl_status" -ne 0 ]; then
  echo "chat request failed (curl exit ${curl_status}); tail of ${SERVER_LOG}:" >&2
  tail -n 40 "$SERVER_LOG" >&2 || true
  exit "$curl_status"
fi
if [ "$http_status" != "200" ]; then
  echo "chat returned HTTP ${http_status}:" >&2
  cat /tmp/prism-chat-response.json >&2 || true
  exit 1
fi

# The response is the adapter's parse target — emit it as the last thing on
# stdout so `run()` can read usage and the reply off this exec's output.
cat /tmp/prism-chat-response.json
printf '\n'
