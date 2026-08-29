#!/usr/bin/env bash
#
# Uninstall a local Prism Agent install created by install.sh:
#   - stop + remove the background service (launchd on macOS, systemd on Linux)
#   - remove the `prism` PATH symlink(s) we created
#   - remove ~/.prism — INCLUDING the agent database and config
#
# Pass -y / --yes to skip the confirmation prompt.
set -euo pipefail

PRISM_HOME="${PRISM_HOME:-$HOME/.prism}"
PRISM_HOME="${PRISM_HOME%/}"
if [ -z "$PRISM_HOME" ] || [ "$PRISM_HOME" = "/" ] || [ "$PRISM_HOME" = "$HOME" ]; then
  echo "Refusing to delete unsafe PRISM_HOME='$PRISM_HOME'" >&2
  exit 1
fi
YES=0
case "${1:-}" in
  -y|--yes) YES=1 ;;
  '') ;;
  *) echo "Usage: $0 [-y|--yes]" >&2; exit 1 ;;
esac

if [ "$YES" -ne 1 ]; then
  echo "This will stop prism-server and permanently delete:"
  echo "  - $PRISM_HOME (binaries, sidecar, config, and the agent database)"
  echo "  - the background service (launchd/systemd)"
  echo "  - the 'prism' symlink on your PATH"
  printf "Continue? [y/N] "
  read -r reply
  case "$reply" in
    y | Y | yes | YES) ;;
    *) echo "Aborted." ; exit 0 ;;
  esac
fi

os="$(uname -s)"

# 1. Stop + remove the service (mirrors install.sh's two backends).
if [ "$os" = "Darwin" ]; then
  launchctl bootout "gui/$(id -u)/com.prism.server" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.prism.server.plist"
  echo "Removed launchd service com.prism.server"
else
  systemctl --user disable --now prism-server.service 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/prism-server.service"
  systemctl --user daemon-reload 2>/dev/null || true
  echo "Removed systemd user service prism-server"
fi

# 2. Remove the PATH symlink(s) — only if they actually point at our install,
#    so we never clobber an unrelated `prism` on the user's PATH.
for link in /usr/local/bin/prism "$HOME/.local/bin/prism"; do
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$PRISM_HOME/prism" ]; then
    rm -f "$link"
    echo "Removed $link"
  fi
done

# 3. Remove the install dir (binaries, sidecar, config, database, workspace).
rm -rf "$PRISM_HOME"
echo "Removed $PRISM_HOME"

echo
echo "Prism Agent uninstalled."
