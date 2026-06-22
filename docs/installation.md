# Install natively

The one-line installer puts two native binaries on your machine and runs the
runtime as an always-on background service. This is the recommended way to use
Prism day to day on your own workstation.

- `prism` — the terminal UI (TUI). Put on your `PATH`; run it from any shell.
- `prism-server` — the agent runtime. Registered as a background service that
  starts at login and restarts on failure.

Both are self-contained native executables — no Node.js or other runtime to
install.

## Install

### macOS / Linux

```bash
curl -fsSL https://raw.githubusercontent.com/lensapp/prism-agent/main/install.sh | bash
```

If `AWS_BEARER_TOKEN_BEDROCK` is exported in your shell when you run the
installer, it's baked into `~/.prism/.env` automatically and the service comes
up working:

```bash
export AWS_BEARER_TOKEN_BEDROCK=<your-key>
curl -fsSL https://raw.githubusercontent.com/lensapp/prism-agent/main/install.sh | bash
```

Otherwise the installer writes `~/.prism/.env` with empty placeholders — edit
that file to add your key, then restart the service (see below).

### Windows (PowerShell)

```powershell
irm https://raw.githubusercontent.com/lensapp/prism-agent/main/install.ps1 | iex
```

As on macOS/Linux, export the key first to bake it in:

```powershell
$env:AWS_BEARER_TOKEN_BEDROCK="<your-key>"
irm https://raw.githubusercontent.com/lensapp/prism-agent/main/install.ps1 | iex
```

The Windows installer needs no admin elevation and pulls in no dependencies —
Windows already ships everything it uses. (On Windows arm64 it installs the x64
build, which runs under emulation.)

## What gets installed

| Item | macOS / Linux | Windows |
|------|---------------|---------|
| Install directory | `~/.prism` | `%USERPROFILE%\.prism` |
| Binaries | `prism`, `prism-server` | `prism.exe`, `prism-server.exe` |
| Config file | `~/.prism/.env` | `%USERPROFILE%\.prism\.env` |
| Agent database | `~/.prism/…/agent.db` | under `%USERPROFILE%\.prism` |
| Shell workspace | `~/.prism/workspace` | `%USERPROFILE%\.prism\workspace` |
| `prism` on PATH via | symlink in `/usr/local/bin` or `~/.local/bin` | `.prism` added to user `PATH` |

The `workspace` directory is the working directory the agent's
[shell tools](tools.md) operate in.

You can override the install directory by setting `PRISM_HOME` before running
the installer.

## The background service

The installer registers `prism-server` to run always — it starts at login and
restarts automatically on failure.

| Platform | Mechanism | Service name |
|----------|-----------|--------------|
| macOS | launchd agent | `com.prism.server` |
| Linux | systemd user service | `prism-server.service` |
| Windows | Scheduled Task (runs at logon) | `PrismServer` |

Logs are written to `~/.prism/server.log` on macOS (and via the service manager
on Linux/Windows).

### Restarting the service

After editing `~/.prism/.env` (for example to add your Bedrock key or Slack
tokens), restart the service to pick up the change:

```bash
# macOS
launchctl kickstart -k "gui/$(id -u)/com.prism.server"

# Linux
systemctl --user restart prism-server.service
```

```powershell
# Windows
Restart-ScheduledTask -TaskName PrismServer
```

### Configuring credentials

The `.env` file is where you set credentials and options. At minimum, set your
Bedrock key:

```bash
AWS_BEARER_TOKEN_BEDROCK=<your-key>
# SLACK_BOT_TOKEN=
# SLACK_APP_TOKEN=
```

See **[Configuration](configuration.md)** for the full list of variables. After
any change, restart the service.

## Supported platforms

Native binaries are published for:

- **macOS** — Apple Silicon (arm64) and Intel (x64)
- **Linux** — x64 and arm64
- **Windows** — x64 (runs under emulation on arm64)

Binaries are attached to each [GitHub Release](https://github.com/lensapp/prism-agent/releases).
The installer downloads the latest release automatically.

## Verifying

Once installed, the runtime listens on port 3003:

```bash
curl http://localhost:3003/health
```

Then open the **[Web UI](web-ui.md)** at <http://localhost:3003>, or run the
**[Terminal UI](terminal-ui.md)**:

```bash
prism
```

## Uninstalling

The repository ships a cleanup script that stops and removes the service, the
`PATH` symlinks, and the install directory (binaries, config, database, and
workspace):

```bash
./cleanup-local-prism.sh        # add -y to skip the confirmation prompt
```

It removes the launchd/systemd registration, deletes the `prism` symlink **only
if it points at your install**, and removes `$PRISM_HOME` (default `~/.prism`).
Because that directory holds the agent database, uninstalling this way also
deletes the agent's memory and history — export a backup from the
**[Web UI](web-ui.md)** first if you want to keep it.
