# Terminal UI

`prism` is a terminal UI for chatting with the agent and managing its state
without leaving the shell — useful on headless servers, over SSH, or just as a
fast keyboard-driven alternative to the browser.

![Prism Terminal UI](images/terminal-ui.png)

```bash
prism
```

By default it connects to a runtime at `http://localhost:3003`. Point it
elsewhere with `PRISM_HTTP_URL` or the `~/.prism/settings.json` file — see the
**[CLI reference](cli-reference.md)** for all flags and settings.

## Starting and resuming conversations

- **Fresh start.** Running `prism` with no flags creates a new conversation
  thread and drops you into the chat view.
- **Resume.** Run `prism --resume` to pick a previous conversation from a
  list. The picker shows each thread's title, how long ago it was active, and
  the working directory (and git branch) it was started in. Select one with the
  arrow keys and Enter; Escape cancels.

To switch to a different thread mid-session, exit and relaunch with `--resume`.

## Chatting

Type your message and press **Enter** to send. While the agent is thinking, the
input shows a spinner and "thinking… (esc to stop)" — press **Escape** to cancel
the in-flight response. Each agent message shows which tools it used; press
**Ctrl+O** to expand the latest message's tool calls and see their inputs and
outputs.

Use **Up / Down** arrows from an empty input to walk back through your message
history.

Press **Ctrl+C** (or run `/exit`) to quit.

## Slash commands

Type `/` to open a command popup; keep typing to filter, **Tab** to complete,
**Enter** to run. The available commands:

| Command | What it does |
|---------|--------------|
| `/help` | List all commands |
| `/copy` | Copy the most recent message to the clipboard |
| `/attach <path>` | Stage a file (≤10 MB) to send with your next message; offers path completion |
| `/detach` | Remove all staged attachments |
| `/save [dir\|file]` | Save files the agent shared in its last message to disk |
| `/rename <name>` | Rename the agent (1–64 characters) |
| `/model <id\|reset>` | Set the agent's model, or `reset` to the server default |
| `/heartbeat-model <id\|reset>` | Set the heartbeat model, or `reset` to inherit the main model |
| `/cron-model <id\|reset>` | Set the scheduled-task model, or `reset` to inherit the main model |
| `/heartbeat <…>` | Control the heartbeat — see below |
| `/goal <…>` | Set or manage a background [goal](#goal) — see below |
| `/skills [list\|run <name>]` | List installed [skills](skills.md), or run one |
| `/schedules` | Open the scheduled-tasks panel |
| `/config` | Open the identity/config viewer panel |
| `/exit` | Shut down the TUI |

### `/heartbeat`

Manage the agent's [heartbeat](heartbeat.md) inline:

- `/heartbeat status` — show whether it's active/running, last run, errors, and
  interval
- `/heartbeat start` / `/heartbeat stop` — enable or disable it
- `/heartbeat trigger` — run a heartbeat right now
- `/heartbeat every 5m` or `/heartbeat every 2h` — set the interval (1 minute to
  7 days)

### `/goal`

Set or manage a **background goal** — an objective the agent keeps working toward
across multiple turns until it's done:

- `/goal <objective>` — set a goal in plain language and start it
- `/goal` or `/goal status` — show the current goal's status (turns, tokens)
- `/goal list` — list all goals
- `/goal pause` / `/goal resume` — pause or resume the active goal
- `/goal stop` (aliases `clear`/`cancel`/`off`) — stop the active goal

The same `/goal` command is also available in the **[Web UI](web-ui.md#chat)**.

### Attaching and saving files

`/attach ./report.pdf` stages a file; it shows above the input with a `/detach`
hint, and is sent with your next message. When the agent shares files back,
`/save` writes them to the current directory — or pass a target: `/save ./out/`
for a directory, or `/save ./out/report.pdf` to name a single file.

## Panels

Two full-screen panels replace the chat view temporarily; **Escape** closes them.

### Schedules panel (`/schedules`)

Lists the agent's [scheduled tasks](scheduled-tasks.md) with their name,
schedule, next run, and active state. From the list:

- **n** — create a new schedule (a form with Name, Schedule, and Instruction
  fields; Tab/arrows to move between fields, Enter to submit)
- **d** — delete the selected schedule (confirm with **y**)
- arrow keys to navigate

### Config panel (`/config`)

A two-pane viewer for the agent's identity. The left pane shows the agent's
name, model (plus the heartbeat and scheduled-task models, or `(main)` when they
inherit it), timezone, and heartbeat status, plus a list of the seven identity
documents (Soul, User, Memory, Heartbeat, Vision, Agent, Bootstrap). The right pane shows the selected document's content. Use Tab or the
left/right arrows to move between panes, up/down to scroll, and Page Up/Down to
page through long documents. It's a viewer — edit these documents through
conversation (see **[The agent's identity](agent-identity.md)**).

## Status bar

The bottom status bar shows the current model (pretty-printed, e.g. "Opus 5.0")
and a red indicator with a message if the connection drops. The TUI reconnects
to the runtime automatically with backoff, buffering anything you send while
it's offline.

For the complete flag list, settings file, and full keyboard-shortcut tables,
see the **[CLI reference](cli-reference.md)**.
