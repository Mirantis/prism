# Tools

Prism is an *agent*, not a chatbot: it has tools, and it decides when to use
them. You don't call tools directly — you talk to the agent, and it reaches for
the right tool to get the job done. This page is a tour of what it can reach
for, so you know what to ask for.

When the agent uses a tool, you can see it: the **[Web UI](web-ui.md#chat)** and
**[Terminal UI](terminal-ui.md#chatting)** both show tool calls (with their
inputs and outputs) inline in the agent's messages.

## Memory

Manage long-term memory. See **[Memory](memory.md)** for the full picture.

- **Search** — recall past entries by meaning, optionally filtered by category
  and recency.
- **Write** — record something worth keeping, with a category (observation /
  action / decision / event) and an importance score.
- **Delete** — remove entries that are no longer accurate.

## Self-management

The agent can edit its own identity from inside a conversation — this is how
"be more concise" or "remember our staging region" actually take effect. See
**[The agent's identity](agent-identity.md)**.

- Rewrite its **Soul**, **User** profile, **Memory**, **Vision**, **Heartbeat**
  config, or **Agent Guide**.
- **Rename** itself.
- Adjust **settings** — heartbeat interval, timezone, verbose (chat delivery
  mode: `true` streams every step, `false` delivers only the final message).
- **Clear the bootstrap** prompt once first-run onboarding is done.

## Scheduling

Create and manage its own [scheduled tasks](scheduled-tasks.md):

- **Schedule** a task using natural language ("every weekday at 9am") or cron.
- **List** existing tasks.
- **Delete** a task.

## Shell

The agent can act on a real shell — this is what lets it do work rather than
just talk about it. By default it works inside a workspace directory (the
`workspace` folder in your install, or `/home/node` in the container): relative
paths resolve from there.

- **Run a command** — execute a shell command and get back stdout, stderr, and
  the exit code. Commands have a timeout (default ~30s, up to 20 minutes) and
  output is size-capped so a noisy command can't flood the context.
- **Read / write / edit files** — read a file (line-numbered), write a file, or
  make an exact-string edit. These tools reject paths outside the workspace.
- **Long-running processes** — spawn a background process, write to its stdin,
  drain its stdout/stderr, and kill it with a signal. Useful for servers, watch
  processes, and interactive tools.

> **On confinement:** the file read/write/edit tools reject paths outside the
> workspace, but running a command does not — `shell_exec` can run anything the
> runtime's OS user is permitted to, including reading paths elsewhere on the
> machine. The workspace is a default working directory, not a security sandbox;
> the real boundary is OS filesystem permissions. For a hard boundary around
> what the agent can reach, run Prism under **[Lens Sandbox](lens-sandbox.md)**.

In the published container image, the shell comes with common tooling
preinstalled — `git`, `gh` (GitHub CLI), `kubectl`, `aws`, `jq`, `yq`, and
`ripgrep` — so the agent can do real operational work out of the box. (Running
under **[Lens Sandbox](lens-sandbox.md)**, every outbound connection those tools
make is checked against your policy.)

## Skills

The agent can load an installed **[Skill](skills.md)** — a `SKILL.md` bundle of
task-specific instructions (the agentskills.io standard) — and follow it. It sees
each available skill's name and description up front and loads the full
instructions on demand when a task matches; you can also list and run skills with
the [`/skills` command](skills.md#the-skills-command). Skills come from a global
directory, an installed **[plugin](plugins.md)**, and — in the terminal UI — the
current repository's `.claude/skills`.

## Plugin tools

An installed **[plugin](plugins.md)** can bring its own MCP tool servers, and
their tools join the agent's tool set alongside the built-ins. They are named
`<plugin id>__<server name>__<tool name>`, so it is always clear which plugin a
tool came from, and they are subject to the same per-mode gating as built-in
tools.

## Claude Code sub-agent

For larger coding tasks, the agent can hand work to **Claude Code** running as an
autonomous sub-agent in the workspace:

- **Start** a Claude Code task with a prompt, in `edit` or `plan` mode, with a
  turn budget.
- **Poll** the running task for output and completion.
- **Stop** a task that is heading the wrong way, looping, or no longer needed.
  The agent gets back whatever output the task produced before it was
  terminated, and can resume that work later instead of starting over.

This lets the agent delegate a self-contained engineering job — "refactor this
module," "investigate this failing test" — and check back on the result, rather
than doing everything in its own turn-by-turn loop.

## Sharing files

The agent can deliver a file from its workspace to you as a **downloadable
attachment** (up to 10 MB). That's how files it produces — a report, an export,
a generated artifact — reach you in the Web UI, Terminal UI, or Slack. In the
TUI, save them to disk with [`/save`](terminal-ui.md#attaching-and-saving-files).

## Attachments

When you send the agent a file, its content is stored as a plain file under
the data dir's `media/` folder (`/data/media` in the container) and the file
appears as a **metadata stub** in the conversation context — the agent sees
the filename, MIME type, size, and an opaque `id`, but not the raw bytes.
This avoids flooding the context window with large payloads. The agent then
decides how to consume the file using two tools:

- **hydrate_attachment** — writes the stored file to a scratch directory on the
  agent's workspace disk. The agent can then inspect it with any shell tool:
  `cat`, `head`, `jq`, `unzip -l`, `pdftotext`, `sqlite3`, `strings`, etc.
  Preferred for text, code, archives, and data files. The scratch files
  are automatically reaped by an hourly janitor. RBAC-scoped: only attachments
  belonging to the caller's own conversation thread are accessible.

- **view_attachment** — pulls an **image** (PNG, JPEG, GIF, WebP) or a **PDF**
  into the model's context without writing to disk: images for visual
  inspection, PDFs as documents the model reads directly (layout, tables, and
  embedded images included — richer than a `pdftotext` dump). Not auto-inlined
  — the agent invokes this on demand. Images larger than ~3.75 MB should be
  hydrated instead; `pdftotext` via hydrate remains the fallback for oversized
  PDFs.

**Retention:** attachment content is kept for **7 days** (168 hours,
configurable via `ATTACHMENT_TTL_HOURS` — see
[Configuration](configuration.md)). An hourly sweep deletes older media files;
the metadata stub stays in the conversation, marked *content expired*, and
downloads answer **410 Gone**. Share the file again if the agent still needs
it.

> **Untrusted data:** the contents of attachments are treated as untrusted
> input — they cannot alter the agent's system prompt or escalate privileges.

## Voice meetings

The agent can join a Google Meet call and take part by voice — see
[Voice meetings](voice-meetings.md). It asks to join, a host admits it, and from
then on it listens and speaks in the room.

How much it speaks up follows the room: on a one-to-one call it answers everything,
and once anyone else is present it waits to be called by name — every time, including
follow-ups. That switches as people come and go, so there is nothing to set — see
[Voice meetings](voice-meetings.md#in-the-call) to override it for a given call.

Inside the call it keeps **every tool above except `share_file`**, so it can look
something up and say the answer. `share_file` is out because it only stores a file for
the chat machinery to deliver, and a meeting doesn't run that machinery — in a call it
could only store a file that reached nobody. Speaking is the agent's only channel from
a meeting: there is no tool for posting to Slack, to your chat session, or to the
meeting's own chat panel.

Nothing else is withheld, so the guardrail is its prompt rather than the tool list:
announce and get an explicit "yes" in the room before anything destructive — including
renaming itself or rewriting its Soul, user profile or memory, which it will do on a
spoken request the room agrees to. Since a meeting has no authentication, treat the
link as granting the agent's authority over itself as well as over your systems, and
share it accordingly.

The meeting tools themselves only exist when the runtime can actually host a call: the
container image's browser/audio toolchain plus `OPENAI_API_KEY` (which a
direct-mode `LLM_PROVIDER=openai` deployment already carries — a Nexus-routed
one can run keyless, and then has no meeting tools). They're also
chat-only — a heartbeat or scheduled run can't dial into a meeting on its own.

## External tools (MCP)

Beyond the built-in tools, the runtime can connect to an external **MCP** server
(configured via `NEXUS_MCP_URL`) to expose additional, project-scoped tools to
the agent. When connected, those tools appear to the agent alongside the
built-in ones and it can use them the same way.

## Large tool outputs

Every tool result the agent reads is capped, built-in and MCP alike, so one
oversized payload can't crowd out the rest of the conversation. In chat — web,
terminal, Slack — the cap is **30,000 characters**. In a [voice
meeting](voice-meetings.md) it is **12,000**, because a call keeps every result in
a much smaller live session and the agent has to *say* its answer.

Past the cap, the agent sees the start and the end of the output with the middle
replaced by a notice that the result is incomplete. The notice tells it not to
quote a count or a total from what it can see, and to ask again more narrowly — a
filter, fewer fields, the next page. So if you ask "how many are open?" about a
long list, expect the agent to either narrow the query itself or tell you the
listing was cut, rather than answer with a number it can't stand behind. The
runtime logs a warning naming the tool and the sizes whenever this happens.
