# Contributing to Prism Agent

Thanks for your interest in Prism Agent.

This repository is the agent runtime — a self-sufficient LLM invocation service
that owns the full agent execution lifecycle: it builds agent context from its
own embedded database, connects to MCP servers for tools, runs heartbeat and
cron scheduling in-process, manages Slack connections, runs the conversation
engine, and delivers results to users over local channel adapters (WebSocket,
Slack). The runtime is bundled with a Web UI (`web/`) and a TUI (`cli/`).
[`AGENTS.md`](AGENTS.md) at the repo root is the authoritative guide to the
architecture, the services, and the project conventions; this file is the short
on-ramp.

## Development Setup

The recommended local loop for **all** agent-runtime work — services, MCP tools,
prompts, conversation engine, heartbeats, cron, the Slack adapter, the WS
gateway, and the bundled Web UI — is `tsx watch` against an embedded SQLite file,
with optional Vite for UI hot-reload.

```bash
npm install

# First time only:
cp .env.example .env
$EDITOR .env                  # uncomment DATABASE_URL

# Every time:
npm run dev:single            # backend on :3003 (cargo run), Vite on :5173 (HMR + proxy)
```

The backend applies pending migrations to SQLite when it starts, so you never run
migrate manually. Slack and Bedrock
are optional and fail-open when their tokens are unset; the SPA shell and most
read-only views work with zero extra env. Add `AWS_BEARER_TOKEN_BEDROCK` (or AWS
SigV4) for chat, and `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN` for Slack flows. See
[`.env.example`](.env.example) for the full env block.

Browser → `http://localhost:5173`. UI edits hot-reload in under a second; after a
backend change, stop `dev:single` and start it again.

To use the container desktop, build the local image with `npm run docker:build`,
then run it with `npm run docker:start`. Rebuild the image after a change.

## The Verification Gate

Run these from the repo root before opening a pull request:

```bash
npm run lint        # oxlint
npm run lint:md     # markdownlint-cli2 over **/*.md
npm test            # cargo test for the backend
npm run build       # backend release build + Web UI build

npm run test:run --workspaces --if-present   # cli + web workspace suites
```

The `commit-msg` and `prepare-commit-msg` Husky hooks run on every commit; CI runs
lint, tests, and the build.

## Tests

New behavior should ship with tests.

- Backend tests are Rust tests beside the code they cover, under `backend/src`;
  `npm test` runs them with `cargo test`.
- Prefer testing observable behavior through a service's public surface over
  reaching into internals.
- The `cli/` and `web/` workspaces each have their own vitest config, so their
  suites need the `--workspaces` form above.

## Pull Request Guidelines

- Keep changes small and focused.
- Add or update tests for every behavior change.
- Changing a runtime HTTP endpoint means updating its callers too — the Web SPA
  under `web/` and the TUI under `cli/`.
- Update documentation when you change public behavior, configuration, or env
  vars. Keep [`AGENTS.md`](AGENTS.md) in sync when you touch architecture.
- A file copied or adapted from another project lands in the same pull request as
  its [`THIRD_PARTY_NOTICES`](THIRD_PARTY_NOTICES) entry. The entry names the
  project, the version, the license, the copyright holder, and the files it
  covers, and reproduces the upstream license text verbatim. A paraphrase is not
  acceptable. The file itself points at `THIRD_PARTY_NOTICES`, in a header comment
  or in a README beside it.

## Commit Style

This repo uses [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
Every commit subject must use the `<type>(<scope>): <description>` form — common
types are `feat`, `fix`, `refactor`, `ci`, `docs`, `chore`, and `test`.

- `feat(slack): re-trigger heartbeat on buffered messages`
- `fix(invoke): unwrap lastError before classifying budget exhaustion`
- `docs(install): note that DATABASE_URL can't be overridden in ~/.prism/.env`
- `test(heartbeat): cover exact-match 24h duplicate suppression`

In the PR description, the Test plan should describe behavior that was actually
exercised (local smoke runs, manual UI walks, specific commands). Don't list a
gating workflow as "green" — it's already a required check on the PR page.

## Security-Sensitive Changes

Changes touching credential handling (Slack tokens and Mirantis Agent Platform credential
sentinels, the Bedrock API key), the MCP tool surface (kubectl, GitHub, AWS),
agent access control, the WebSocket JWT path, or the agent's own SQLite data
should include a short note on the security impact in the pull request
description. For vulnerability reports, follow [SECURITY.md](SECURITY.md).
