#!/usr/bin/env bash
#
# Prism installer (macOS + Linux).
#
# Installs the `prism` (terminal UI) and `prism-server` (agent runtime)
# binaries plus the server's sidecar (node_modules/, web/) into ~/.prism,
# symlinks `prism` into PATH, and registers `prism-server` to run always
# (launchd on macOS, a systemd user service on Linux).
#
# Run it from a built checkout (after scripts/build-sea.mjs + collect-natives.mjs)
# or point PRISM_DIST at a directory containing the artifacts for this platform.
set -euo pipefail

PRISM_HOME="${PRISM_HOME:-$HOME/.prism}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) plat="darwin" ;;
  Linux)  plat="linux" ;;
  *) echo "Unsupported OS: $os — this installer is macOS/Linux only." >&2; exit 1 ;;
esac
case "$arch" in
  arm64|aarch64) a="arm64" ;;
  x86_64|amd64)  a="x64" ;;
  *) echo "Unsupported arch: $arch" >&2; exit 1 ;;
esac

DIST="${PRISM_DIST:-$SCRIPT_DIR/dist-sea/${plat}-${a}}"
if [ ! -x "$DIST/prism-server" ] || [ ! -x "$DIST/prism" ]; then
  # No local build present — fetch the latest release archive for this
  # platform. Lets the installer also work via `curl … | bash` (no checkout
  # required). Override locally by setting PRISM_DIST.
  echo "No local build at $DIST; fetching the latest release from GitHub…"
  TAG=$(curl -fsSL https://api.github.com/repos/lensapp/prism-agent/releases/latest \
        | grep -oE '"tag_name"[[:space:]]*:[[:space:]]*"[^"]+"' \
        | sed -E 's/.*"([^"]+)"$/\1/' \
        | head -n1)
  if [ -z "$TAG" ]; then
    echo "Could not resolve the latest release. Set PRISM_DIST to a local build to install offline." >&2
    exit 1
  fi
  OS_ARCH="${plat}-${a}"
  ARCHIVE="prism-${TAG}-${OS_ARCH}.tar.gz"
  URL="https://github.com/lensapp/prism-agent/releases/download/${TAG}/${ARCHIVE}"
  TMP="$(mktemp -d)"
  trap 'rm -rf "$TMP"' EXIT
  echo "Downloading ${ARCHIVE} (${TAG})…"
  if ! curl -fsSL -o "$TMP/$ARCHIVE" "$URL"; then
    echo "Download failed: $URL" >&2
    echo "Make sure the latest release publishes ${ARCHIVE} (your platform/arch)." >&2
    exit 1
  fi
  echo "Extracting…"
  tar -xzf "$TMP/$ARCHIVE" -C "$TMP"
  DIST="$TMP/$OS_ARCH"
  if [ ! -x "$DIST/prism-server" ] || [ ! -x "$DIST/prism" ]; then
    echo "Extracted archive doesn't contain expected layout at $OS_ARCH/" >&2
    exit 1
  fi
fi

echo "Installing Prism into $PRISM_HOME (from $DIST)"
mkdir -p "$PRISM_HOME"
# Workspace root for the shell / claude_code tools. The runtime's built-in
# default (/home/node) is the Docker sandbox path and doesn't exist here; a
# missing cwd makes tool subprocess spawns fail with a misleading ENOENT.
mkdir -p "$PRISM_HOME/workspace"
cp "$DIST/prism" "$PRISM_HOME/prism"
cp "$DIST/prism-server" "$PRISM_HOME/prism-server"
chmod +x "$PRISM_HOME/prism" "$PRISM_HOME/prism-server"
rm -rf "$PRISM_HOME/node_modules" "$PRISM_HOME/web"
cp -R "$DIST/node_modules" "$PRISM_HOME/node_modules"
cp -R "$DIST/web" "$PRISM_HOME/web"

# License, attribution and third-party notices. Guarded because a dist-sea/
# built by build-sea.mjs + collect-natives.mjs alone (see the header) has none.
# A release archive always has them: the cp in scripts/build-binaries.sh runs
# under `set -e`, and scripts/smoke-sea.mjs checks all three on four platforms.
for f in LICENSE NOTICE THIRD_PARTY_NOTICES; do
  if [ -f "$DIST/$f" ]; then cp "$DIST/$f" "$PRISM_HOME/$f"; fi
done

# Config template — never clobber an existing one.
if [ ! -f "$PRISM_HOME/.env" ]; then
  # Bake AWS_BEARER_TOKEN_BEDROCK from the installer's environment when set —
  # launchd/systemd run the service with an isolated env, so the user's shell
  # exports otherwise wouldn't reach it. Heredoc isn't single-quoted so the
  # var expands; `\$(id -u)` keeps the macOS restart hint literal.
  cat > "$PRISM_HOME/.env" <<EOF
# Prism server configuration. Restart the service after editing:
#   macOS: launchctl kickstart -k "gui/\$(id -u)/com.prism.server"
#   Linux: systemctl --user restart prism-server
#
# DATABASE_URL is hard-coded to file:\$PRISM_HOME/agent.db by the
# prism-server binary before this file is read, so setting it here has no
# effect — move \$PRISM_HOME if you need a different location.
AWS_BEARER_TOKEN_BEDROCK=${AWS_BEARER_TOKEN_BEDROCK:-}
# SLACK_BOT_TOKEN=
# SLACK_APP_TOKEN=
EOF
  if [ -n "${AWS_BEARER_TOKEN_BEDROCK:-}" ]; then
    echo "Wrote $PRISM_HOME/.env with AWS_BEARER_TOKEN_BEDROCK from the installer environment."
  else
    echo "Wrote $PRISM_HOME/.env — set AWS_BEARER_TOKEN_BEDROCK for chat."
  fi
fi

# Put `prism` on PATH.
BINDIR="/usr/local/bin"
[ -w "$BINDIR" ] 2>/dev/null || BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
ln -sf "$PRISM_HOME/prism" "$BINDIR/prism"
echo "Linked $BINDIR/prism -> $PRISM_HOME/prism"
case ":$PATH:" in
  *":$BINDIR:"*) ;;
  *) echo "WARN: $BINDIR is not on \$PATH — add it to your shell rc to run 'prism' directly." ;;
esac

# Register prism-server to run always.
if [ "$plat" = "darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/com.prism.server.plist"
  mkdir -p "$(dirname "$PLIST")"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.prism.server</string>
  <key>ProgramArguments</key><array><string>$PRISM_HOME/prism-server</string></array>
  <key>WorkingDirectory</key><string>$PRISM_HOME</string>
  <!-- launchd starts the service with a minimal PATH (/usr/bin:/bin:...), but
       the runtime spawns user CLIs by bare name (e.g. \`claude\`). Bake a PATH
       that includes the common install dirs so those resolve. Unquoted heredoc
       expands \$HOME/\$PATH to the installer's values. -->
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH</string>
    <key>SHELL_WORKSPACE_ROOT</key><string>$PRISM_HOME/workspace</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PRISM_HOME/server.log</string>
  <key>StandardErrorPath</key><string>$PRISM_HOME/server.log</string>
</dict>
</plist>
EOF
  # WorkingDirectory=~/.prism lets the server's dotenv pick up ~/.prism/.env.
  # Idempotent (re)install of the launchd agent. `launchctl load` returns
  # "Load failed: 5: I/O error" on re-installs when the service is already
  # loaded — that's a misleading error from launchd; the service usually
  # *did* load. Tolerate it and use kickstart -k as the source of truth.
  # If that says the service isn't loaded, bootout/bootstrap can race on
  # modern macOS, so retry a few times before giving up.
  DOMAIN="gui/$(id -u)"
  SERVICE="$DOMAIN/com.prism.server"
  echo "Registering launchd service com.prism.server (this can take a moment)…"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    if launchctl kickstart -k "$SERVICE" 2>/dev/null; then break; fi
    launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null || true
    sleep 1
  done
  launchctl kickstart -k "$SERVICE"  # final attempt — let it fail loudly if still stuck
  echo "Loaded launchd service com.prism.server"
else
  UNIT="$HOME/.config/systemd/user/prism-server.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<EOF
[Unit]
Description=Prism agent runtime
After=network.target

[Service]
Type=simple
ExecStart=$PRISM_HOME/prism-server
WorkingDirectory=$PRISM_HOME
EnvironmentFile=-$PRISM_HOME/.env
# systemd user units start with a minimal PATH, but the runtime spawns user
# CLIs by bare name (e.g. claude). Bake a PATH with the common install dirs.
Environment=PATH=$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH
# Workspace root for the shell / claude_code tools (the built-in /home/node
# default doesn't exist on a standalone install).
Environment=SHELL_WORKSPACE_ROOT=$PRISM_HOME/workspace
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  echo "Registering systemd user service prism-server (this can take a moment)…"
  systemctl --user daemon-reload
  systemctl --user enable --now prism-server.service
  echo "Enabled systemd user service prism-server"
fi

echo
echo "Done. prism-server is starting on http://127.0.0.1:3003 — run 'prism' to connect."
