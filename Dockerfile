# Prism Agent Dockerfile
# Multi-stage build for smaller production image.
#
# Base: node:26-bookworm-slim (glibc).

# Stage 1: Build
FROM node:26-bookworm-slim AS builder

WORKDIR /app

# All three workspace manifests up front so a single root `npm ci` resolves
# the full graph (root + web + cli) against the committed lockfile.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY cli/package.json ./cli/

# Skip husky install in Docker
ENV HUSKY=0

# Opt out of Prisma CLI telemetry (checkpoint pings on generate/migrate).
ENV CHECKPOINT_DISABLE=1

# openssl is needed by Prisma's query engine on Debian slim (not shipped by default).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# .npmrc mounted as secret so token never persists in image layers.
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci --ignore-scripts

# Copy source for the runtime
COPY src ./src
COPY prisma ./prisma
COPY tsconfig.json ./

# Generate the Prisma client. Skipped by --ignore-scripts above, so do it explicitly.
RUN npx prisma generate --schema=prisma/sqlite/schema.prisma

# Build runtime TypeScript
RUN npx tsc

# Build the web bundle from the workspace.
COPY web ./web
RUN npm run build --workspace=prism-agent-web

# Build the prism CLI from the workspace. Bundled into the image so an
# operator can `docker exec -it <container> prism`.
COPY cli ./cli
RUN npm run build --workspace=prism-cli

# Stage 2: Production
FROM node:26-bookworm-slim AS runner

WORKDIR /app

# Skip husky install in Docker
ENV HUSKY=0

# Opt out of Prisma CLI telemetry (checkpoint pings on generate/migrate).
# ENV (not build-only ARG) so it also covers the runtime migrate in start.sh.
ENV CHECKPOINT_DISABLE=1

# openssl for Prisma; wget for the healthcheck probe.
# git/ca-certificates/curl/libatomic1/gcc/libc-dev/make/zstd are baked
# into nexus-shell-sandbox (see nexus-monorepo
# crates/nexus-shell-sandbox/Dockerfile:20-22) — needed by `gh`'s git
# interop, by mise's install + plugin compile path, and by tools that
# pull zstd-compressed archives. ripgrep is also installed via apt
# instead of via mise because mise's aqua backend lacks a linux/arm64
# build for it; Debian's package is single-binary and works everywhere.
# Ships so `shell_exec` from agents has the same toolchain surface as
# the upstream Nexus-hosted shell sandbox.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl wget \
        git ca-certificates curl libatomic1 gcc libc-dev make zstd \
        ripgrep \
        iptables \
    && rm -rf /var/lib/apt/lists/*

# Install only production dependencies. Scope to root + cli — the web
# workspace's node_modules isn't needed at runtime (we only ship its
# built dist/), so skip it to keep the image smaller.
# .npmrc mounted as secret so token never persists in image layers.
COPY package.json package-lock.json ./
COPY web/package.json ./web/
COPY cli/package.json ./cli/

RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci --workspace=prism-cli --include-workspace-root --omit=dev --ignore-scripts

# `npm ci --ignore-scripts` skipped better-sqlite3's prebuild-install step
# (which downloads the platform-specific native binding). Rebuild just that
# package so the SQLite + sqlite-vec path works.
RUN npm rebuild better-sqlite3

# Claude Code CLI: the `claude_code` / `claude_code_status` MCP tools spawn
# this binary as a sub-agent. Installed globally so a child
# `spawn('claude', …)` finds it on PATH. Auth piggybacks on the parent's
# inherited env (AWS_BEARER_TOKEN_BEDROCK, CLAUDE_CODE_USE_BEDROCK).
RUN npm install -g @anthropic-ai/claude-code

# Operator CLIs via mise — parity with the upstream Nexus-hosted
# shell sandbox (`nexus-monorepo/crates/nexus-shell-sandbox/Dockerfile:24-30`).
# Without these, FU-5's `shell_exec` is mostly useless beyond `ls /data`:
# agents asking the obvious "list pods in cluster X" / "open a PR" /
# "list S3 buckets" hit `command not found`. Installed under the `node`
# user so the shims live in /home/node and stay accessible at runtime
# (the outer Nexus sandbox drops privileges to `node`).
#
# Same tool set as upstream. Split between mise and apt:
#   - mise (below): awscli, kubectl, gh, jq, yq.
#   - apt (earlier RUN): ripgrep — mise's aqua plugin lacks a linux/arm64
#     ripgrep build, Debian's package works on both arches.
# Credentials are out of scope for this image — the outer sandbox's
# MITM-injection model rewrites `__nexus_cred:<id>__` placeholders on
# the wire (no creds on disk).
USER node
ARG MISE_VERSION=v2026.2.16
# mise's aqua backend resolves each tool's release through the GitHub API.
# Unauthenticated that's ~60 req/hr/IP — CI runners share IPs and trip a
# 403 "rate limit exceeded" (e.g. resolving yq's release tag). Mitigated two
# complementary ways:
#   1. Authenticate when a token is supplied via the `github_token` build
#      secret (never persisted in a layer). Raises the API limit by orders of
#      magnitude. Optional (required=false) so a token-less local
#      `docker:build` still works — it just falls back to the cache below.
#   2. Cache mise's download/metadata dir across builds with a BuildKit cache
#      mount, so a cold layer-cache rebuild reuses already-resolved versions
#      and downloaded archives instead of re-hitting the API. The install dir
#      (~/.local/share/mise) stays in the image layer, so the tools still ship.
RUN --mount=type=secret,id=github_token,uid=1000,required=false \
    --mount=type=cache,target=/home/node/.cache/mise,uid=1000,gid=1000 \
    export MISE_CACHE_DIR=/home/node/.cache/mise; \
    GITHUB_TOKEN="$(cat /run/secrets/github_token 2>/dev/null || true)"; \
    export GITHUB_TOKEN MISE_GITHUB_TOKEN="$GITHUB_TOKEN" AQUA_GITHUB_TOKEN="$GITHUB_TOKEN"; \
    curl -fsSL https://mise.jdx.dev/install.sh | MISE_VERSION=${MISE_VERSION} sh \
 && ~/.local/bin/mise use -g \
        awscli@latest \
        kubectl@latest \
        gh@latest \
        jq@latest \
        yq@latest
ENV PATH="/home/node/.local/share/mise/shims:/home/node/.local/bin:${PATH}"
USER root

# Copy the Prisma schema and generate the client for runtime
COPY prisma ./prisma
RUN npx prisma generate --schema=prisma/sqlite/schema.prisma

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy the built Web UI bundle. Server.ts serves `web/dist` via
# `express.static` for non-API routes.
COPY --from=builder /app/web/dist ./web/dist

# prism CLI: Ink-based TUI for talking to this runtime. Bundled so an
# operator can `docker exec -it <container> prism` and connect over the
# in-container default (http://localhost:3003). Prod deps were installed
# by the workspace-scoped `npm ci` above; just drop in the built dist.
COPY --from=builder /app/cli/dist ./cli/dist
RUN chmod +x /app/cli/dist/index.js \
 && ln -s /app/cli/dist/index.js /usr/local/bin/prism

# Startup orchestrator. The pending-import preflight is compiled into
# `dist/scripts/apply-pending-import.js` by the builder stage above —
# same code path the `dev:single` npm script runs via tsx.
COPY start.sh ./
RUN chmod +x ./start.sh

# Set environment
ENV NODE_ENV=production
ENV PORT=3003

# OTEL product telemetry — baked at publish time by deploy.yml /
# release-deploy.yml. Empty defaults keep PR-validation and local builds
# telemetry-off (config.ts treats '' as disabled). Operators can override
# or disable with `docker run -e OTEL_EXPORTER_OTLP_ENDPOINT=`.
ARG OTEL_EXPORTER_OTLP_ENDPOINT=""
ARG DEPLOYMENT_ENVIRONMENT=development
ENV OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}
ENV DEPLOYMENT_ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}

# Absent or empty secret (PR validation, local builds) bakes nothing.
RUN --mount=type=secret,id=otel_api_key \
    if [ -s /run/secrets/otel_api_key ]; then \
      install -m 0444 /run/secrets/otel_api_key /app/.otel-api-key; \
    fi

EXPOSE 3003

# Per-agent SQLite DB and the installed skills bundles live here. Owned by node
# so the runtime user can write; the skills/ subdir is pre-created so first-boot
# ownership is correct before the runtime's ensureDataDirs() touches it.
RUN mkdir -p /data/skills && chown -R node:node /data
VOLUME ["/data"]

# The persistent data dir for the runtime (skills, Claude Code config). The
# resolver (src/lib/data-dir.ts) uses PRISM_DATA_DIR when set, else ~/.prism —
# so the container points it at the mounted /data volume here.
ENV PRISM_DATA_DIR=/data

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3003/health || exit 1

# Drop the runtime user from root → node. The agent has no root-requiring
# runtime path: port 3003 is unprivileged, /data is already chown'd to
# node above, and the generated Prisma client + dist layers are 0755/0644.
USER node

CMD ["./start.sh"]
