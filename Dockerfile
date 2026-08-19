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
#
# poppler-utils (pdftoppm/pdftotext/pdfimages), tesseract-ocr, and the
# fonts stack are the document-skills toolchain — the Anthropic pdf/docx/
# xlsx/pptx skills shell out to them. Unlike the operator CLIs below they
# stay on apt (not mise): they're multi-file C/C++ packages with data files
# and font integration, not the single GitHub-release binaries mise's aqua
# backend handles (same reason ripgrep is apt). This intentionally diverges
# from the nexus-shell-sandbox parity set. Python + pandoc, which mise CAN
# provide, are added to the `mise use -g` line below instead.
#
# xvfb + pulseaudio are the voice-meeting toolchain (see src/services/meeting/):
# a browser joins the call, Xvfb gives it a display because Meet's WebRTC path is
# unreliable headless, and PulseAudio's null-sinks are the virtual speaker and
# microphone the runtime exchanges audio through. This is the one place we
# knowingly spend image size on a feature rather than a CLI (~400MB) — unlike
# LibreOffice, left out for exactly that reason, there is no way to be in a
# meeting without a browser and an audio server.
#
# Debian's `chromium` rather than Google Chrome. Chrome does now have arm64 Linux
# builds, and the runtime prefers `/usr/bin/google-chrome` when an image happens to
# provide it — but Meet's refusals turned out to be about being an *anonymous*
# automated guest, not about the browser build, so there is nothing to buy with a
# second browser and a third-party apt repo. Sign-in is the fix (see
# services/meeting/browser-stack.ts).
RUN apt-get update && apt-get install -y --no-install-recommends \
        openssl wget \
        git ca-certificates curl libatomic1 gcc libc-dev make zstd \
        ripgrep \
        poppler-utils \
        tesseract-ocr \
        fonts-liberation fontconfig \
        iptables \
        chromium xvfb pulseaudio pulseaudio-utils \
        tini \
        binutils \
        file \
        p7zip-full \
        sqlite3 \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# Count the CA certificates this image ships with, so start.sh can tell which
# ones a sandbox supervisor appended at boot. The supervisor appends its
# TLS-interception CAs to the bundle, so its certs are always the suffix and
# everything past this count is one of them. A count is all the comparison needs.
#
# Must stay in this layer: `ca-certificates` above is what creates the bundle,
# and nothing later in the build touches it.
RUN grep -c 'BEGIN CERTIFICATE' /etc/ssl/certs/ca-certificates.crt \
      > /etc/ssl/certs/ca-certificates.count

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
# Same tool set as upstream, plus the document-skills interpreter, split
# between mise and apt:
#   - mise (below): awscli, kubectl, gh, jq, yq, python, pandoc.
#   - apt (earlier RUN): ripgrep — mise's aqua plugin lacks a linux/arm64
#     ripgrep build, Debian's package works on both arches — plus
#     poppler-utils/tesseract-ocr/fonts (not single-binary, apt-only).
# python + pandoc go through mise (both first-class, both arm64): one
# consistent mechanism, a newer pandoc 3.x (vs bookworm's 2.17), and a
# python-build-standalone interpreter that is node-owned and NOT PEP-668
# externally-managed — so `pip install` works globally with no venv, both
# for the baked requirements below and for skills installing extra libs at
# runtime (PyPI is on the egress allowlist).
# Credentials are out of scope for this image — the outer sandbox's
# MITM-injection model rewrites `__nexus_cred:<id>__` placeholders on
# the wire (no creds on disk).
#
# Pre-create ~/.cache node-owned: mise v2026.7.12 verifies tool downloads via
# sigstore/cosign, whose TUF client writes a cache dir under ~/.cache. The
# BuildKit cache mount on the next RUN creates the parent /home/node/.cache as
# root, so without this the sigstore cache fails with "Permission denied" and
# the gh/jq/yq installs abort.
RUN mkdir -p /home/node/.cache && chown node:node /home/node/.cache
USER node
# Bumped from v2026.2.16 → v2026.7.12: the older mise picked a freethreaded
# stripped python-build-standalone tarball for `python@3.13` that it couldn't
# lay out ("missing lib directory"); v2026.7.12 selects the correct build.
ARG MISE_VERSION=v2026.7.12
# python is pinned to an exact patch: 3.13.15's from-source build fails in
# `make install` while ensurepip bootstraps the bundled pip wheel (python-build
# 2.8.3, Debian bookworm, amd64 and arm64 alike). Re-float to python@3.13 once
# a fixed patch release or python-build definition ships.
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
    # Never compile Python from source: when a CPython patch release has no
    # python-build-standalone build, mise's compile fallback breaks the image
    # build (its pyenv python-build bootstrap is fragile in-container).
    # This does not choose the version — the exact pin below does that. It
    # makes a missing precompiled build fail the install outright instead of
    # silently falling back to a source build, and it is what would make
    # re-floating to `python@3.13` safe.
    export MISE_PYTHON_COMPILE=false; \
    curl -fsSL https://mise.jdx.dev/install.sh | MISE_VERSION=${MISE_VERSION} sh \
 && ~/.local/bin/mise use -g \
        awscli@latest \
        kubectl@latest \
        gh@latest \
        jq@latest \
        yq@latest \
        python@3.13.14 \
        pandoc@latest

# Baked document-skills pip set — a separate layer AFTER the mise tool install
# so editing the pins doesn't rebuild the CLI-install layer above (which floats
# the `@latest` tools). Installs into the node-owned mise python: no venv, not
# PEP-668-managed. pip reaches PyPI (build network / egress allowlist), not the
# GitHub API, so no token/cache mounts are needed here.
COPY --chown=node:node requirements.txt ./
RUN ~/.local/bin/mise exec -- pip install --no-cache-dir -r /app/requirements.txt
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

# OTEL product telemetry — baked at publish time by release-canary.yml /
# release-production.yml. Empty defaults keep PR-validation and local builds
# telemetry-off (config.ts treats '' as disabled). Operators can override
# or disable with `docker run -e OTEL_EXPORTER_OTLP_ENDPOINT=`.
ARG OTEL_EXPORTER_OTLP_ENDPOINT=""
ARG DEPLOYMENT_ENVIRONMENT=development
ENV OTEL_EXPORTER_OTLP_ENDPOINT=${OTEL_EXPORTER_OTLP_ENDPOINT}
ENV DEPLOYMENT_ENVIRONMENT=${DEPLOYMENT_ENVIRONMENT}

# Build identifier surfaced as the OTel `service.version` resource attribute on
# every product-telemetry event. release-production.yml passes the release tag
# (e.g. v2026.6.18060952); release-canary.yml passes the build commit SHA.
# Empty default keeps PR-validation and local builds from emitting a misleading
# literal — config.ts treats '' as "omit the attribute".
ARG SERVICE_VERSION=""
ENV SERVICE_VERSION=${SERVICE_VERSION}

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

# Where Chromium reads managed policies. Debian's chromium package ships
# /etc/chromium root-owned and the runtime user has no sudo, so only the build can
# create this directory, and it must be node-owned or the policy file cannot be
# written at run time. The need is certificate trust: behind a TLS-intercepting
# proxy Chromium rejects a proxied host with ERR_CERT_AUTHORITY_INVALID until a
# CACertificates policy names the proxy's CA — with that drop-in the same host
# answered HTTP 200. Chromium reads managed policy at process start, so the file
# must exist before the browser launches.
#
# A runtime-writable policy directory widens the image's trust surface on purpose:
# a file here can install a trusted CA, force extensions or set a proxy for every
# browser the image runs. It is node-owned because `start.sh` writes the CA policy
# there on every boot (see the block in that file) — inside a sandbox the trust
# anchors are only knowable at run time, since one of them is generated per
# container start.
#
# /etc/opt/chrome too: resolveBrowser() prefers /usr/bin/google-chrome when a
# derived image provides it, and Chrome reads its policies from there (see
# BROWSER_CANDIDATES in services/meeting/browser-stack.ts).
RUN mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed \
 && chown node:node /etc/chromium/policies/managed /etc/opt/chrome/policies/managed

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -q --spider http://127.0.0.1:3003/health || exit 1

# Drop the runtime user from root → node. The agent has no root-requiring
# runtime path: port 3003 is unprivileged, /data is already chown'd to
# node above, and the generated Prisma client + dist layers are 0755/0644.
USER node


# Run under tini so PID 1 reaps orphans.
#
# Needed because Chromium's crash handler deliberately re-parents itself to PID 1,
# and Node only reaps children it spawned itself — so every voice meeting left four
# unreapable zombies behind, accumulating for the life of the container (measured:
# 4 after one call, 8 after two). The same applies to anything the agent
# double-forks from its shell tools, so this fixes a latent leak beyond meetings.
#
# tini forwards signals to start.sh, so the graceful-shutdown path (SIGTERM ->
# node -> service teardown) is unchanged.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["./start.sh"]
