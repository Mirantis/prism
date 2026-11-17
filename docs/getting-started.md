# Getting Started

This page gets you from nothing to a running agent you can chat with. For the
full details of each install method, follow the links to the dedicated guides.

## Prerequisites

- **An LLM credential.** Prism Agent uses AWS Bedrock by default. The only required
  credential for chat is a **Bedrock API key** exported as
  `AWS_BEARER_TOKEN_BEDROCK`. (SigV4 credentials — `AWS_ACCESS_KEY_ID` /
  `AWS_SECRET_ACCESS_KEY` — also work; the SDK auto-selects the bearer token
  when it's set.)
- **A platform.** Native binaries are published for macOS (Apple Silicon),
  Linux (x64 and arm64), and Windows (x64). The Docker image runs on
  linux/amd64 and linux/arm64.
- **Nothing else.** No database to provision, no message broker, no extra
  services. The agent embeds its own SQLite database.

> Slack and the various observability integrations are optional — the agent
> starts fine without them. Add them later when you need them.

## The fastest path

Export your Bedrock key, then run the one-line installer. If the key is present
in your shell, the installer bakes it into the service config so the agent comes
up working out of the box.

### macOS / Linux

```bash
export AWS_BEARER_TOKEN_BEDROCK=<your-key>
curl -fsSL https://raw.githubusercontent.com/Mirantis/prism/main/install.sh | bash
```

### Windows (PowerShell)

```powershell
$env:AWS_BEARER_TOKEN_BEDROCK="<your-key>"
irm https://raw.githubusercontent.com/Mirantis/prism/main/install.ps1 | iex
```

The installer downloads the latest release, installs the `prism` and
`prism-server` binaries into `~/.prism` (`%USERPROFILE%\.prism` on Windows),
puts `prism` on your `PATH`, and registers `prism-server` to run always in the
background. See **[Install natively](installation.md)** for exactly what gets
installed and how to manage the service.

Prefer a container? See **[Run with Docker](docker.md)** instead.

## First run

Once the service is up, the runtime listens on port **3003**. Check it:

```bash
curl http://localhost:3003/health
```

On its very first boot with an empty database, Prism Agent auto-creates its
workspace (using `AGENT_NAME`, `TEAM_NAME`, and `OWNER_USER_ID` if you set
them, otherwise sensible defaults). Every subsequent boot finds and reuses that
workspace.

### Say hello

Open the **Web UI** at <http://localhost:3003> and start a conversation, or
launch the **Terminal UI** from your shell:

```bash
prism
```

Either way, the agent greets you and — on a fresh install — walks you through a
short **bootstrap** conversation to learn who you are and what you want it to
do. Answer its questions; it writes your answers into its own identity documents
and then clears the bootstrap prompt. See
**[The agent's identity](agent-identity.md)** for what it's setting up.

## Where to go next

- Learn the **[Web UI](web-ui.md)** or **[Terminal UI](terminal-ui.md)**.
- Give the agent standing work: **[Heartbeat](heartbeat.md)** and
  **[Scheduled tasks](scheduled-tasks.md)**.
- Wire it into **[Slack](slack.md)**.
