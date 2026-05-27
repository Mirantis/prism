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
  echo "Binaries not found in $DIST." >&2
  echo "Build them first: node scripts/build-sea.mjs prism && node scripts/build-sea.mjs prism-server && npm run build:web && node scripts/collect-natives.mjs" >&2
  echo "or set PRISM_DIST to a directory containing prism, prism-server, node_modules/ and web/." >&2
  exit 1
fi

echo "Installing Prism into $PRISM_HOME (from $DIST)"
mkdir -p "$PRISM_HOME"
cp "$DIST/prism" "$PRISM_HOME/prism"
cp "$DIST/prism-server" "$PRISM_HOME/prism-server"
chmod +x "$PRISM_HOME/prism" "$PRISM_HOME/prism-server"
rm -rf "$PRISM_HOME/node_modules" "$PRISM_HOME/web"
cp -R "$DIST/node_modules" "$PRISM_HOME/node_modules"
cp -R "$DIST/web" "$PRISM_HOME/web"

# Config template — never clobber an existing one.
if [ ! -f "$PRISM_HOME/.env" ]; then
  cat > "$PRISM_HOME/.env" <<'EOF'
# Prism server configuration. Restart the service after editing:
#   macOS: launchctl kickstart -k "gui/$(id -u)/com.prism.server"
#   Linux: systemctl --user restart prism-server
AWS_BEARER_TOKEN_BEDROCK=
# SLACK_BOT_TOKEN=
# SLACK_APP_TOKEN=
EOF
  echo "Wrote $PRISM_HOME/.env — set AWS_BEARER_TOKEN_BEDROCK for chat."
fi

# Put `prism` on PATH.
BINDIR="/usr/local/bin"
[ -w "$BINDIR" ] 2>/dev/null || BINDIR="$HOME/.local/bin"
mkdir -p "$BINDIR"
ln -sf "$PRISM_HOME/prism" "$BINDIR/prism"
echo "Linked $BINDIR/prism -> $PRISM_HOME/prism"

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
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$PRISM_HOME/server.log</string>
  <key>StandardErrorPath</key><string>$PRISM_HOME/server.log</string>
</dict>
</plist>
EOF
  # WorkingDirectory=~/.prism lets the server's dotenv pick up ~/.prism/.env.
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load "$PLIST"
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
Restart=always
RestartSec=2

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now prism-server.service
  echo "Enabled systemd user service prism-server"
fi

echo
echo "Done. prism-server is starting on http://127.0.0.1:3003 — run 'prism' to connect."
