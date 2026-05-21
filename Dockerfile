# Prism Agent Dockerfile
# Multi-stage build for smaller production image.
#
# Base: node:24-bookworm-slim (glibc). Previously node:24-alpine (musl); the
# switch is required so the image can be wrapped by Dockerfile.nexus-sandbox,
# which layers a glibc-linked nexus-agent-sandbox binary on top.

# Stage 1: Build
FROM node:24-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./

# Skip husky install in Docker
ENV HUSKY=0

# openssl is needed by Prisma's query engine on Debian slim (not shipped by default).
RUN apt-get update && apt-get install -y --no-install-recommends openssl && rm -rf /var/lib/apt/lists/*

# .npmrc mounted as secret so token never persists in image layers.
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci --ignore-scripts

# Copy source for the runtime
COPY src ./src
COPY prisma ./prisma
COPY tsconfig.json ./

# Generate both Prisma clients (Postgres for multi-tenant, SQLite for
# single-agent mode). Skipped by --ignore-scripts above, so do it explicitly.
RUN npx prisma generate \
 && npx prisma generate --schema=prisma/sqlite/schema.prisma

# Build runtime TypeScript
RUN npx tsc

# Build web bundle as a self-contained step — web/ is not wired up as an npm
# workspace in this repo, so install its deps here and run its build script.
COPY web ./web
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    cd web && npm install --no-audit --ignore-scripts && npm run build

# Build the prism CLI the same way — also not a declared workspace. Bundled
# into the image so an operator can `docker exec -it <container> prism`.
COPY cli ./cli
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    cd cli && npm install --no-audit --ignore-scripts && npm run build

# Stage 2: Production
FROM node:24-bookworm-slim AS runner

WORKDIR /app

# Skip husky install in Docker
ENV HUSKY=0

# openssl for Prisma; wget for the healthcheck probe.
# git/ca-certificates/curl/libatomic1/gcc/libc-dev/make/zstd are baked
# into nexus-shell-sandbox (see nexus-monorepo
# crates/nexus-shell-sandbox/Dockerfile:20-22) — needed by `gh`'s git
# interop, by mise's install + plugin compile path, and by tools that
# pull zstd-compressed archives. ripgrep is also installed via apt
# instead of via mise because mise's aqua backend lacks a linux/arm64
# build for it; Debian's package is single-binary and works everywhere.
# Ships in single-agent mode so `shell_exec` from agents has the same
# toolchain surface as the multi-tenant Nexus-hosted shell sandbox.
# iptables is required by the nexus-agent-sandbox supervisor that the
# Nexus k8s agent provisioner injects via an init container at runtime
# — it runs as root inside this image and shells out to iptables to
# cage outbound traffic through its embedded HTTPS proxy.
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl wget \
        git ca-certificates curl libatomic1 gcc libc-dev make zstd \
        ripgrep \
        iptables \
    && rm -rf /var/lib/apt/lists/*

# Install only production dependencies
# .npmrc mounted as secret so token never persists in image layers
COPY package.json package-lock.json ./

RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    npm ci --omit=dev --ignore-scripts

# `npm ci --ignore-scripts` skipped better-sqlite3's prebuild-install step
# (which downloads the platform-specific native binding). Rebuild just that
# package so single-agent mode's SQLite + sqlite-vec path works.
RUN npm rebuild better-sqlite3

# Claude Code CLI: the `claude_code` / `claude_code_status` MCP tools spawn
# this binary as a sub-agent in single-agent mode. Installed globally so a
# child `spawn('claude', …)` finds it on PATH. Auth piggybacks on the
# parent's inherited env (AWS_BEARER_TOKEN_BEDROCK, CLAUDE_CODE_USE_BEDROCK).
# Harmless in multi-tenant mode — the MCP tool is only registered when
# config.singleAgentMode is true, so the binary simply goes unused.
RUN npm install -g @anthropic-ai/claude-code

# Operator CLIs via mise — parity with the multi-tenant Nexus-hosted
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
RUN curl -fsSL https://mise.jdx.dev/install.sh | MISE_VERSION=${MISE_VERSION} sh \
 && ~/.local/bin/mise use -g \
        awscli@latest \
        kubectl@latest \
        gh@latest \
        jq@latest \
        yq@latest
ENV PATH="/home/node/.local/share/mise/shims:/home/node/.local/bin:${PATH}"
USER root

# Copy Prisma schemas and generate both clients for runtime
COPY prisma ./prisma
RUN npx prisma generate \
 && npx prisma generate --schema=prisma/sqlite/schema.prisma

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy the built Web UI bundle. Server.ts conditionally serves `web/dist` from
# `express.static` when SINGLE_AGENT_MODE=true; the wrapper sandbox image
# enables that mode at runtime.
COPY --from=builder /app/web/dist ./web/dist

# prism CLI: Ink-based TUI for talking to this runtime. Bundled so an
# operator can `docker exec -it <container> prism` and connect over the
# in-container default (http://localhost:3003).
COPY cli/package.json ./cli/
RUN --mount=type=secret,id=npmrc,target=/app/.npmrc \
    cd cli && npm install --omit=dev --no-audit --ignore-scripts
COPY --from=builder /app/cli/dist ./cli/dist
RUN chmod +x /app/cli/dist/index.js \
 && ln -s /app/cli/dist/index.js /usr/local/bin/prism

# Startup orchestrator (shared with Dockerfile.nexus-sandbox). The
# pending-import preflight is compiled into `dist/scripts/apply-pending-
# import.js` by the builder stage above — same code path the `dev:single`
# npm script runs via tsx.
COPY start.sh ./
RUN chmod +x ./start.sh

# Set environment
ENV NODE_ENV=production
ENV PORT=3003

EXPOSE 3003

# Per-agent SQLite DB lives here in single-agent mode. Owned by node so the
# privilege-dropped sandbox process can write. Multi-tenant mode ignores this
# directory.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3003/health || exit 1

# Drop the runtime user from root → node. The Nexus k8s agent supervisor
# starts the container as runAsUser:0, installs iptables, then setuids to
# the image's declared USER before exec'ing AGENT_COMMAND (see
# nexus-sandbox-core::privilege::apply). Multi-tenant deploys and local
# `docker run` honor this USER directly. The agent has no root-requiring
# runtime path: port 3003 is unprivileged, /data is already chown'd to
# node above, and the generated Prisma client + dist layers are 0755/0644.
USER node

CMD ["./start.sh"]
