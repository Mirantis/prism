# Tools

Prism Agent is an *agent*, not a chatbot: it has tools, and it decides when to use
them. You don't call tools directly — you talk to the agent, and it reaches for
the right tool to get the job done. This page is a tour of what it can reach
for, so you know what to ask for.

When the agent uses a tool, you can see it: the **[Web UI](web-ui.md#chat)** and
**[Terminal UI](terminal-ui.md#chatting)** both show tool calls (with their
inputs and outputs) inline in the agent's messages.

## Risk gate

Operators can optionally put sensitive tool calls through a fast-model safety
check before execution by setting `TOOL_RISK_GATE_MODE`. In `observe` mode the
runtime records what the gate would block without changing behavior; in
`enforce` mode rejected calls do not execute and appear as failed tool calls.
See [Configuration](configuration.md#tool-risk-gate) for rollout and failure
behavior.

The gate covers every tool call, apart from low-risk helpers that bypass it to
avoid a classification round trip for every poll. It is an additional
check rather than a confinement boundary; OS permissions still
determine what the runtime can actually access.

Your **[Agent Guide](agent-identity.md)** is the gate's policy. Write a rule in
it and the check follows that rule: name a cluster the agent must not touch, or
a job it may do without asking. Where the guide says nothing, the built-in
rules apply. See [Configuration](configuration.md#tool-risk-gate) for what a
rule in the guide can override.

## Questions

**Ask questions** — when the agent needs your decisions in a chat, it can ask them
as one card with answer options. Choose your answers and send them, skip any
question, or type a reply instead. In Slack, Teams and the terminal UI the same
questions arrive as text, and you reply in your own words or with `1a, 2b`.

## Charts, tables and buttons

**Show UI** — when a chart, a table, a comparison or a few buttons say more than
prose, the agent shows them as a message of its own in the web chat and in Slack.
Ask for one in your own words, such as "compare these plans in a table". The first
press of a button sends its label as your reply, and the buttons then show who
pressed. The terminal UI and Teams show the same content as text.

## Memory

Manage long-term memory. See **[Memory](memory.md)** for the full picture.

- **Search** — recall past entries by meaning, or list the newest ones. A search
  can be limited to a category and a time window, and ordered by relevance or
  newest first.
- **Write** — record something worth keeping, with a category (observation /
  action / decision / event) and an importance score.
- **Delete** — remove entries that are no longer accurate.

**Write** and **Delete** are withheld and refused while
**[locked-in mode](configuration.md#locked-in-mode)** is on. **Search** stays.

## Compacted history

**Read compacted history** — read the earlier messages of the conversation that
a [compaction](compaction.md) summary replaced, with their tool calls and
results, or search them for a word. A search shows the part of a long message
around the match, and the agent can then read the messages around it or the
whole message. The agent uses it when the summary leaves out a detail it needs.

## Self-management

The agent can edit its own identity from inside a conversation — this is how
"be more concise" or "remember our staging region" actually take effect. See
**[The agent's identity](agent-identity.md)**.

- Rewrite its **Soul**, **User** profile, **Memory**, **Vision**, or
  **Heartbeat** config. Not the **Agent Guide** — that one is yours to edit, and
  no tool reaches it.
- **Rename** itself.
- Adjust **settings** — heartbeat interval, timezone, verbose (chat delivery
  mode: `true` streams every step, `false` delivers only the final message).
- **Clear the bootstrap** prompt once first-run onboarding is done.

When **[locked-in mode](configuration.md#locked-in-mode)** is on, the document
writers, "clear the bootstrap" and the memory write/delete tools are withheld and
their writes refused — renames, settings and memory search stay available.

## Scheduling

Create and manage its own [scheduled tasks](scheduled-tasks.md):

- **Schedule** a task using natural language ("every weekday at 9am") or cron.
- **List** existing tasks.
- **Delete** a task.

## Shell

The agent can act on a real shell — this is what lets it do work rather than
just talk about it. By default it works inside a workspace directory — the
`workspace` folder in your install, or `/prism/workspace` when commands run in a
container: relative paths resolve from there.

- **Run a command** — execute a shell command and get back stdout, stderr, and
  the exit code. Commands have a timeout (default ~30s, up to 20 minutes) and
  output is size-capped so a noisy command can't flood the context.
- **Read / write / edit files** — read a file (line-numbered), write a file, or
  make an exact-string edit. These tools reject paths outside the workspace.
- **Long-running processes** — spawn a background process, write to its stdin,
  drain its stdout/stderr, and kill it with a signal. Useful for servers, watch
  processes, and interactive tools.

### Where commands run

When Docker is available, the agent's commands run in a container, and so does
everything it works with: the workspace at `/prism/workspace`, your skills, your
plugins, and each coding agent's login. Nothing to set up — the runtime finds
the engine and uses it. Set `EXECUTION_ENVIRONMENT=local` to keep commands on
your machine, or `docker` to require the container.

That storage is kept by Docker, not in a folder of yours, and it outlives the
container: restart the agent, upgrade it, and the workspace is as the agent left
it. To put a file in or take one out, run `docker cp` yourself — the agent has no
Docker client inside the container, so it cannot. For example,
`docker cp ./my-skill prism-agent-exec-<id>:/prism/skills/` installs a skill,
which the agent then picks up without a restart. `docker ps` names the container.

When you install a container engine, or take one away, the agent's files move
with it: its workspace, skills, plugins and both coding-agent logins are copied
across on the next start, and nothing already on the other side is overwritten.
Its memory, conversations and identity are not affected either way, because
those live in the agent's database, which stays on your machine. If you remove
the engine for good, set `EXECUTION_ENVIRONMENT=local`, or each start first
waits for the engine the last run used.

Two things follow. Anything written **outside** `/prism` — in `/tmp` inside the
container, say — is gone when the agent restarts, so keep work in the workspace.
And a conversation you start with `prism` inside a repository runs its commands
on your machine instead, because the container has no access to that repository;
the startup log says so when it happens. If the container is removed while the
agent runs, its commands fail until you restart the agent.

> **On confinement:** in a container, a command reaches the agent's own storage
> and nothing else of yours — not your files, not your home directory, and not
> the agent's database. On your machine it is different: the file
> read/write/edit tools reject paths outside the workspace, but running a
> command does not — `shell_exec` can run anything the runtime's OS user is
> permitted to. There the workspace is a default working directory rather than a
> boundary.

In the published container image, the shell comes with common tooling
preinstalled — `git`, `gh` (GitHub CLI), `kubectl`, `aws`, `jq`, `yq`, and
`ripgrep` — so the agent can do real operational work out of the box.

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

## Coding sub-agent

For a task of many steps, such as research, a report, a document or code, the
agent can hand the work to a **coding agent** running as an autonomous
sub-agent in the workspace. The tool lists available agents;
pass `agent: "claude-code"`, `agent: "codex"`, or `agent: "agy"` to choose one for a task, or omit
`agent` to use the `CODING_AGENT` default. Use the same `agent` with a returned
`sessionId` to resume a task.
A Claude Code task has the agent's [MCP tools](#external-tools-mcp), plugin
tools included. It also has the MCP servers Claude Code loads itself. On your
Claude subscription these include your claude.ai connectors. A repository's
`.mcp.json` adds its servers, and Claude Code starts their commands when a task
starts in that repository. When Claude Code loads a server with the name of one
of the agent's servers, the task uses the agent's server. Claude Code calls
claude.ai connectors through `mcp-proxy.anthropic.com`, so the sandbox's network
policy must allow that host. The end of a task's result names each server that
failed to connect, with that host for a claude.ai connector. It also names each
remote server that Claude Code lists as `needs-auth`. Claude Code gives that
status to a server whose host the sandbox blocks. In a conversation you start with `prism` inside
a repository while commands [run in a container](#where-commands-run), the task
leaves out plugin servers that start a command, because those run in the
container.
The Docker image includes Claude Code and Codex; for a local installation, run
`npm install -g @anthropic-ai/claude-code @openai/codex`. Install the Antigravity CLI (`agy`)
on `PATH` and sign in locally to use `agent: "agy"`.

If you set `CLAUDE_CONFIG_DIR`, Claude Code uses that directory and Prism leaves
it untouched; link its `skills` directory to your Prism skills directory to share
installed skills. When commands run in a container, each CLI keeps its login
with the agent's other storage and that setting does not apply.
To run tasks on your own subscription, turn it on as Configuration shows for
[Claude Code](configuration.md#coding-tasks-on-a-claude-subscription) and for
[Codex](configuration.md#codex-tasks-on-a-chatgpt-subscription).

- **Start** a task with a prompt, in `edit` or `plan` mode, with a turn
  budget for Claude Code.
- **Poll** the running task for output and completion. In a chat
  conversation there is no need: when the task ends, the agent gets its result
  in that conversation and replies, and you can keep talking to it meanwhile.
- **Stop** a task that is heading the wrong way, looping, or no longer needed.
  The agent gets back whatever output the task produced before it was
  terminated, and can resume that work later instead of starting over.

This lets the agent delegate a self-contained job — "research this topic and
write a report," "investigate this failing test" — and check back on the
result, rather than doing everything in its own turn-by-turn loop.

A Claude Code task runs under Claude Code's own permission checks, and its result
names each action they refused. A Codex task runs without Codex's sandbox and can
write anywhere its user can; a Codex plan task is read-only by instruction only. An
Antigravity CLI edit task runs with `--dangerously-skip-permissions`, and a plan task
runs in `plan` mode. See [Configuration](configuration.md#what-a-coding-task-may-do).

## Monitors

In a chat, ask the agent to tell you when something happens, such as an error
in a log, a service coming up or a job ending, and it watches for it in the
background while you keep talking. It replies the moment the event happens. A
watch stops after 5 minutes unless you ask for longer, up to 30 minutes, and the
agent can start it again.

## Reading web pages

Give the agent the address of a public page and it reads the page's text without
opening a browser. It opens a page that needs a sign-in or JavaScript in
[its computer](computer.md). For a page on a private network, it uses its computer
or the shell.

## Sending messages

The agent can post a message to a Slack or Microsoft Teams channel, a thread in
one, or a DM that is linked to it, and to nowhere else. Ask it in a conversation
or in a scheduled task's instruction, for example "post the release notes to
`#release`". It mentions a person to notify them, and that person has to be in
the channel. It refuses `@channel`, `@here`, `@everyone` and group mentions.

## Sharing files

The agent can deliver a file from its workspace to you as a **downloadable
attachment** (up to 10 MB). That's how files it produces — a report, an export,
a generated artifact — reach you in the Web UI, Terminal UI, or Slack. In the
TUI, save them to disk with [`/save`](terminal-ui.md#attaching-and-saving-files).
The agent can also show an image, such as a chart, inside its reply at the place
where the text explains it, by naming an image file in its workspace (the same
bound as `share_file`) or an image in the conversation. The Terminal UI
[draws it there in terminals that support it](terminal-ui.md#images-in-replies) and shows
`[image: …]` elsewhere, and `/save` saves the image with the other files of that turn.
A heartbeat, webhook run or scheduled task that doesn't continue a conversation
can't share a file: it reaches you only through the messages it posts, which
carry text alone.

## Attachments

When you send the agent a file, its content is stored as a plain file under
the data dir's `media/` folder (`/data/media` in the container) and the file
appears as a **metadata stub** in the conversation context — the agent sees
the filename, MIME type, size, and an opaque `id`, but not the raw bytes.
This avoids flooding the context window with large payloads. The agent then
decides how to consume the file using two tools:

- **hydrate_attachment** — writes the stored file to a scratch directory on the
  agent's workspace disk. Nothing is on disk before this call, and the filename
  in the stub is not a path. The tool returns the absolute path to use with
  shell tools: `cat`, `head`, `jq`, `unzip -l`, `pdftotext`, `sqlite3`,
  `strings`, etc.
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

> **Untrusted data:** the agent is instructed to treat attachment contents as
> data, never as instructions, because a shared file can carry adversarial
> text. This is a system-prompt instruction, not a sandbox — the agent still
> holds its shell and MCP tools while it reads a file, so share files from
> sources you trust.

## Voice meetings

The agent can join a Google Meet call and take part by voice — see
[Voice meetings](voice-meetings.md). It asks to join, a host admits it, and from
then on it listens and speaks in the room.

How much it speaks up follows the room: on a one-to-one call it answers everything,
and once anyone else is present it waits to be called by name — every time, including
follow-ups. That switches as people come and go, so there is nothing to set — see
[Voice meetings](voice-meetings.md#in-the-call) to override it for a given call.

Inside the call it keeps **every tool above except `share_file` and the message
tools**, plus one only the
model in the call has: reading the call's chat. `share_file` is out because it only
stores a file for the chat machinery to deliver, and a meeting doesn't run that
machinery — in a call it could only store a file that reached nobody.

The agent can post a short plain-text message, up to 500 characters, into the chat panel
of the call it is in. It can post from inside the call, from a chat session, or from a
scheduled run reporting back on work the call kicked off; with no call live it posts
nothing and says so.

A line it posts from a chat session or a scheduled run is stored with the thread like any
other tool argument. Posted from inside the call, nothing is stored.

It reads that panel only when somebody in the call asks it to look, and nothing tells it a
message arrived — so say in the room that you have pasted something. It comes back with
the newest 20 messages, each with the name the call shows for whoever sent it, and says
when it did not get the whole chat or had to cut a long message short. The read is the one
tool a chat session and a scheduled run do not get: a stored tool result is replayed into
every later turn, and the chat is other people's words. Nothing it reads is kept with the
thread.

Work the call has no time for is the one thing that goes on afterwards — the agent
schedules it as a one-off task and the result lands in your chat, not in the room.

Nothing else is withheld, so the guardrail is its prompt rather than the tool list:
announce and get an explicit "yes" in the room before anything destructive — including
renaming itself or rewriting its Soul, user profile or memory, which it will do on a
spoken request the room agrees to. Since a meeting has no authentication, treat the
link as granting the agent's authority over itself as well as over your systems, and
share it accordingly.

The meeting tools themselves only exist when the runtime can actually host a call: the
container image's browser/audio toolchain plus `OPENAI_API_KEY` (which a
direct-mode `LLM_PROVIDER=openai` deployment already carries — one routed
through the Mirantis Agent Platform gateway can run keyless, and then has no meeting tools).
Joining and leaving are chat-only — a heartbeat or scheduled run can't dial
into a meeting, or hang up on one, by itself.

## External tools (MCP)

Beyond the built-in tools, the runtime can connect to an external **MCP** server
(configured via `NEXUS_MCP_URL`) to expose additional, project-scoped tools to
the agent. When connected, those tools appear to the agent alongside the
built-in ones and it can use them the same way.

### Many MCP tools

When the MCP and plugin tools would take more than a small share of the model's
context, the agent gets a short list of them and loads a tool's full definition
when it needs that tool. A tool it loaded stays loaded for the rest of the
conversation. Set `TOOL_SEARCH=off` to send every tool in full; see
[configuration](configuration.md#models).

## Large tool outputs

Every tool result the agent reads is capped, built-in and MCP alike, so one
oversized payload can't crowd out the rest of the conversation. In chat — web,
terminal, Slack — the cap is **30,000 characters**. In a [voice
meeting](voice-meetings.md) it is **12,000**, because a call keeps every result in
a much smaller live session and the agent has to *say* its answer.

Past the cap, the agent sees the start and the end of the output with the middle
replaced by a notice that the result is incomplete. The notice tells it not to
quote a count or a total from what it can see. So if you ask "how many are open?"
about a long list, expect the agent to either narrow the query itself or tell you
the listing was cut, rather than answer with a number it can't stand behind.

**The middle is saved, not lost.** The whole output is written to a file under the
agent's data directory, and the truncation notice gives the agent the path. It reads
what it needs with the shell — `jq` when the payload is JSON, which most tool
results are, otherwise `grep` or `sed`. So the part it wasn't shown is still
reachable, in a call as well as in chat. Saved copies are kept for **7 days**
(configurable via `TOOL_OUTPUT_TTL_HOURS`).

The agent is told to pull only what it needs rather than read the file back whole:
everything it reads returns to the context the cap just protected. So expect it to
query the saved copy for the specific thing, or re-run the original tool with
narrower arguments, rather than page through it.

The conversation stores the capped view — what the agent actually read — rather
than the raw payload. The tool-call inspector in the web UI and the terminal shows
that same view, labelled with how much was cut. The runtime logs a warning naming
the tool and the sizes whenever a result is cut.
