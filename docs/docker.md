# Run with Docker

Prism Agent is published as a multi-arch container image. One container runs one
agent, with its database persisted in a mounted volume.

- **Image:** `ghcr.io/mirantis/prism:latest`
- **Architectures:** linux/amd64, linux/arm64
- **Ports:** 3003 (Web UI and API), 3004 ([webhooks](webhooks.md))
- **Data:** the agent's SQLite database lives at `/data/agent.db` inside the
  container — mount a volume at `/data` to persist it.

Five tag families are published:

| Tag | Points at | Moves? |
|-----|-----------|--------|
| `latest` | the newest production release | yes |
| `vYYYY.M.DDHHMMSS` | one production release | no |
| `canary` | the newest build of `main` | yes |
| `<commit-sha>` | one commit, full 40-character SHA | no |
| `pr-<number>`, `pr-<number>-<branch-slug>` | the head of an open pull request | yes |

Use `latest` or a `vYYYY.M.DDHHMMSS` tag for a normal deployment. `canary` is
built from every merge to `main`, so it carries changes that no release has
shipped yet. A commit-SHA tag pins one exact build, which is what to use when a
deployment must not change under it. The pull-request tags are for trying a
change before it merges. They move with every push that rebuilds the image, so a
docs-only push leaves them on the previous commit. They are deleted when the pull
request closes. A pull request from a fork publishes no image, because its
registry token is read-only.

To update, pull a newer tag and recreate the container; the agent's state
survives on the `/data` volume. A platform that runs the container can update
the image for you.

## Run the agent and boot into the terminal UI

```bash
docker run -it -p 3003:3003 -v prism-data:/data -e AWS_BEARER_TOKEN_BEDROCK \
  ghcr.io/mirantis/prism:latest \
  /bin/sh -c './start.sh > /dev/null 2>&1 & exec prism'
```

This starts the runtime in the background and attaches your terminal to the
`prism` TUI. A few notes:

- `-e AWS_BEARER_TOKEN_BEDROCK` (no `=`) passes the value through from your
  parent shell — so export it first: `export AWS_BEARER_TOKEN_BEDROCK=<your-key>`.
- `-v prism-data:/data` persists the agent's database in the `prism-data` named
  volume across container restarts.
- `-p 3003:3003` exposes the runtime so you can also reach the
  **[Web UI](web-ui.md)** at <http://localhost:3003>. That publishes the port on
  every interface of the host, so the network can connect to it. Publish it to
  this machine only with `-p 127.0.0.1:3003:3003`, or put an authenticating
  proxy in front of it (see
  [Who can reach the runtime](configuration.md#who-can-reach-the-runtime)).

## Run the runtime only (server)

If you only want the HTTP runtime (Web UI, Slack, WebSocket) and not the
attached TUI, run the image with its default entrypoint:

```bash
docker run -d --name prism \
  -p 3003:3003 \
  -v prism-data:/data \
  -e AWS_BEARER_TOKEN_BEDROCK=<your-key> \
  ghcr.io/mirantis/prism:latest
```

The image's default command runs `start.sh`, which applies database migrations,
applies any pending `.prism` import, and then launches the server. The server
backfills memory embeddings in the background as it starts. The container
exposes a health check on `GET /health`.

You can still open a TUI against a running server container:

```bash
docker exec -it prism prism
```

## Persisting data

Everything the agent knows — identity, conversation history, memory, scheduled
tasks, and Slack mappings — lives in the single SQLite database at
`/data/agent.db`. Shared file content (chat uploads, Slack attachments) lives
next to it as plain files under `/data/media`, kept for 7 days (see
**[Tools](tools.md#attachments)**). Mount a volume at `/data` (named volume or
host bind mount) so both survive container restarts and image upgrades. You can
stop the container at any time: when it starts again, the agent continues the
work it was doing. A call in progress ends, and so does a command the agent left
running in the background. Back up
the agent by backing up that volume, or export a `.prism` snapshot from the
**[Web UI](web-ui.md)** (the snapshot carries the database, not the media
files).

`start.sh` defaults `DATABASE_URL` to `file:/data/agent.db`; you generally don't
need to set it. See **[Configuration](configuration.md)** for the rest of the
environment variables.

## Pinning the agent identity

By default the container generates a fresh agent UUID on first boot and reuses
it on later boots (it's stored in the database). To pin a specific identity —
useful when re-creating a container against an existing data volume — set
`AGENT_ID` to a UUID.

## What's in the image

The image bundles the tools the agent's shell can reach (`git`, `gh`, `kubectl`,
`aws`, `jq`, `yq`, `ripgrep`, `python` + `pip`, `pandoc`, `poppler-utils`, and
`tesseract`, plus Claude Code and Codex) so the agent can do real
work out of the box. It
runs as a non-root `node` user and drops privileges after setup.

The `python`/`pandoc`/`poppler`/`tesseract` set — plus the Python libraries the
Anthropic `pdf`/`docx`/`xlsx`/`pptx` skills import (`openpyxl`, `python-pptx`,
`pypdf`, `pdfplumber`, `Pillow`, and more; see `requirements.txt`) — is the
toolchain those document skills need. The image ships the *toolchain*, not the
skills themselves; skills are installed at runtime into `/data/skills`, and
[plugins](plugins.md) into `/data/plugins`. Because
`python` is a node-owned, non-externally-managed interpreter, `pip install`
works out of the box (against PyPI, which is already reachable — no extra network
allowances needed). LibreOffice is intentionally not bundled (size), so document
skills' LibreOffice-backed conversion/recalc/render paths are unavailable.

The image also carries `chromium`, `xvfb` and `pulseaudio`, which are what
[voice meetings](voice-meetings.md) need: a real browser joins the call, Xvfb gives
it a display, and PulseAudio's virtual sinks are the speaker and microphone the
runtime exchanges audio through. They add roughly 400 MB, and unlike LibreOffice
above there is no way to join a meeting without a browser and an audio server, so
they are bundled rather than left out. It's Debian's `chromium`
rather than Google Chrome because only the former is packaged for arm64, and the
image is multi-arch. `/etc/chromium/policies/managed` and
`/etc/opt/chrome/policies/managed` — where Chromium and Chrome read managed
policies — are both pre-created and owned by the runtime user, because those `/etc`
trees are root-owned and the container has no `sudo`. Chrome's is there for a
derived image that adds it, since the runtime prefers `google-chrome` when one is
present. Behind a TLS-intercepting proxy, that is where a certificate policy makes
the browser trust the proxy's certificate authority instead of rejecting every
proxied page. In a sandbox `start.sh` writes `prism-ca.json` into both on every
start, since the sandbox's CAs are only knowable at run time (see
[voice meetings](voice-meetings.md#egress)).
Voice meetings additionally need `OPENAI_API_KEY` (already present when the
container runs `LLM_PROVIDER=openai` chat direct — through the Mirantis Agent Platform
gateway that provider needs no local key, and the meeting tools then stay off
without one); without it
the toolchain sits idle and the meeting tools aren't offered.
