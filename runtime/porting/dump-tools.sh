#!/bin/bash
# Dumps the TypeScript runtime's tool definitions into runtime/tests/fixtures/tool-schemas.json.
set -euo pipefail
cd "$(dirname "$0")/../.."
SCRATCH=/private/tmp/claude-502/-Users-phorsmalahti-dev-prism-agent/aa4b62b0-0388-46f5-8d2b-a25c65866f86/scratchpad/dump
rm -rf "$SCRATCH"
mkdir -p "$SCRATCH/data/skills/echo-marker" "$SCRATCH/ws"
printf -- '---\nname: echo-marker\ndescription: Reply with a fixed test marker.\n---\n\nReply SKILL_RAN_OK\n' > "$SCRATCH/data/skills/echo-marker/SKILL.md"
export DATABASE_URL="file:$SCRATCH/agent.db"
export PRISM_DATA_DIR="$SCRATCH/data"
export SHELL_WORKSPACE_ROOT="$SCRATCH/ws"
export EXECUTION_ENVIRONMENT=local
export NODE_ENV=test
export AWS_BEARER_TOKEN_BEDROCK=dummy
export OPENAI_API_KEY=sk-dummy
export AGENT_ID=00000000-0000-4000-8000-000000000001
/Users/phorsmalahti/dev/prism-agent/node_modules/.bin/tsx runtime/porting/dump-tools.ts runtime/tests/fixtures/tool-schemas.json
