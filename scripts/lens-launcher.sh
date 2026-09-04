#!/bin/sh
# Starts Lens Desktop on the agent's desktop.
#
# --no-sandbox: Chromium's sandbox needs user namespaces or a privileged setuid helper.
# A rootless podman container has the namespaces; a Docker container with the default
# seccomp profile and capabilities has neither, and Chromium then refuses to start.
# --disable-dev-shm-usage: Chromium keeps its frame buffers in /dev/shm, which a container
# gets 64 MB of by default. Lens' renderer fills that on its first window and dies with a
# check failure, leaving a picture nothing behind it answers to; with the flag the buffers
# go to /tmp instead.
exec /opt/Lens/lens-desktop --no-sandbox --disable-dev-shm-usage "$@"
