# CLI reference

Reference for `prism`, the Prism Agent terminal UI — flags, slash commands,
keyboard shortcuts, and the settings file. For a guided tour, see
**[Terminal UI](terminal-ui.md)**.

```
prism [command] [flags]
```

## Commands

| Command | Description |
|---------|-------------|
| `prism` | Start the terminal UI. |
| `prism update` | Check for a newer release and install it. The server downloads, verifies, and restarts; the command waits until the new version is up. |

## Flags

| Flag | Description |
|------|-------------|
| `--resume` | Show a picker of previous conversations to resume, instead of starting fresh. |
| `--version`, `-v` | Print the version and exit. |
| `--help`, `-h` | Print help and exit. |

## Connecting to the runtime

`prism` talks to a `prism-server` over HTTP and a WebSocket. By default it uses
`http://localhost:3003`. Override it with:

- the `PRISM_HTTP_URL` environment variable, or
- the `httpUrl` key in `~/.prism/settings.json`.

There's no authentication for the bundled single-agent runtime — the TUI talks
to it directly on localhost.

## Slash commands

Type `/` in the chat input to open the command popup; filter by typing, **Tab**
or **Enter** to complete the selection, then **Enter** to run.

| Command | Arguments | Description |
|---------|-----------|-------------|
| `/help` | — | List all commands. |
| `/copy` | — | Copy the most recent message to the clipboard. |
| `/attach` | `<path>` | Stage a file (≤10 MB) to send with the next message. Offers path completion. |
| `/detach` | — | Remove all staged attachments. |
| `/save` | `[dir\|file]` | Save files shared by the agent's most recent message to disk (current dir by default). |
| `/rename` | `<name>` | Rename the agent (1–64 characters). |
| `/model` | `<id>` \| `reset` | Set the agent's model, or reset to the server default. |
| `/heartbeat-model` | `<id>` \| `reset` | Set the heartbeat model, or `reset` to inherit the main model. |
| `/cron-model` | `<id>` \| `reset` | Set the scheduled-task model, or `reset` to inherit the main model. |
| `/heartbeat` | `status` \| `start` \| `stop` \| `trigger` \| `every <N>m`\|`<N>h` | Control the heartbeat (interval 1 min – 7 days). |
| `/goal` | `<objective>` \| `status` \| `list` \| `pause` \| `resume` \| `stop` | Set or manage a background goal the agent pursues across turns. |
| `/skills` | `[list]` \| `run <name>` | List installed [skills](skills.md), or run one. |
| `/plugins` | — | List installed [plugins](plugins.md) and what each contributes. |
| `/compact` | — | Summarize older history to free up context ([compaction](compaction.md)). |
| `/update` | — | Check for a newer Prism release and install it (native installs only). |
| `/schedules` | — | Open the scheduled-tasks panel. |
| `/webhooks` | — | Open the webhooks panel. |
| `/config` | — | Open the identity/config viewer panel. |
| `/agent-guide` | — | Edit the agent guide in `$EDITOR` (the agent cannot write it). |
| `/exit` | — | Shut down the TUI. |

## Keyboard shortcuts

### Chat

| Key | Action |
|-----|--------|
| `Enter` | Send the message (or run the slash command). While the command popup is open, Enter completes the selection instead of sending. Works while the agent is responding — the message is handed to the running turn. |
| `Esc` | Cancel the in-flight response while the agent is thinking. Leaves what you have typed alone. |
| `Ctrl+O` | Expand / collapse tool calls in the latest agent message. |
| `Up` / `Down` | Walk back/forward through your message history (from an empty input). |
| `Ctrl+C` | Quit. |

### Command popup (while typing `/…`)

| Key | Action |
|-----|--------|
| `Up` / `Down` | Move the selection. |
| `Tab` | Complete the selected command or path. |
| `Enter` | Complete the selected command, the same as `Tab`. Press Enter again to run it. In the `/attach` path popup Enter sends instead — complete a path with `Tab`. |

### Resume picker (`--resume`)

| Key | Action |
|-----|--------|
| `Up` / `Down` | Move between threads. |
| `Enter` | Resume the selected thread. |
| `Esc` | Cancel and exit. |

### Schedules panel (`/schedules`)

| Key | Action |
|-----|--------|
| `Up` / `Down` | Navigate the list. |
| `n` | Create a new schedule. |
| `d` | Delete the selected schedule (`y` to confirm). |
| `Tab` / arrows | Move between fields in the create form. |
| `Enter` | Submit the form. |
| `Esc` | Close the panel / cancel. |

### Webhooks panel (`/webhooks`)

| Key | Action |
|-----|--------|
| `Up` / `Down` | Navigate the list. |
| `Space` | Pause or resume the selected subscription. |
| `Enter` | Edit the selected subscription; in the form, save it. |
| `Tab` / arrows | Move between fields in the form. |
| `Left` / `Right` | Change **Deliver to**. |
| `Space` (form) | Toggle **Deliver only**, or open the prompt in `$EDITOR`. |
| `Esc` | Close the panel / cancel. |

### Config panel (`/config`)

| Key | Action |
|-----|--------|
| `Tab` / `←` `→` | Move between the file list and the content pane. |
| `Up` / `Down` | Select a document / scroll content. |
| `Page Up` / `Page Down` | Page through content. |
| `Esc` | Close the panel. |

## Settings file

`~/.prism/settings.json` configures the TUI. All keys are optional; missing keys
fall back to defaults, and a malformed file is ignored.

```json
{
  "agentName": "Prism",
  "modelId": "global.anthropic.claude-opus-5-5",
  "heartbeatModelId": "global.anthropic.claude-haiku-4-5",
  "cronModelId": "global.anthropic.claude-sonnet-4-6",
  "httpUrl": "http://localhost:3003",
  "hideCursor": false,
  "hideStatusBar": false
}
```

| Key | Purpose | Default |
|-----|---------|---------|
| `agentName` | Display name in the header and chat | `Prism` |
| `modelId` | Model label shown in the status bar *until the runtime reports the model it actually ran*, which then takes over; also seeds the main model when the runtime first bootstraps an agent | runtime default |
| `heartbeatModelId` | Seeds the heartbeat model when the runtime first bootstraps an agent | unset (inherits main model) |
| `cronModelId` | Seeds the scheduled-task model when the runtime first bootstraps an agent | unset (inherits main model) |
| `httpUrl` | Runtime base URL | `http://localhost:3003` |
| `hideCursor` | Hide the input cursor (accessibility) | `false` |
| `hideStatusBar` | Hide the bottom status bar (accessibility) | `false` |

`PRISM_HTTP_URL` overrides `httpUrl` when set. The runtime (sharing `~/.prism/`)
reads `modelId`, `heartbeatModelId`, and `cronModelId` from this file only when
it **first creates an agent** — see
[Configuration → Bootstrap model defaults](configuration.md#bootstrap-model-defaults-prismsettingsjson).
