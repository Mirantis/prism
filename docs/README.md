# Prism Agent Documentation

Prism Agent is self-contained. One container, one embedded database, no
external services. It persists between conversations, keeps its own memory,
runs heartbeat checks on a schedule, can put work on its own calendar, and can
act over a shell. The only hard dependency is an LLM provider.

These docs walk you from a first install through every feature the agent has.

![Prism Agent Web UI](images/web-ui.png)

## Getting started

- **[Getting Started](getting-started.md)** — prerequisites, the fastest path
  to a running agent, and your first conversation.

## Running Prism Agent

Three ways to run the same agent. Pick one.

- **[Run with Docker](docker.md)** — pull the published image and run the
  agent in a container with a persistent data volume.
- **[Install natively](installation.md)** — the one-line installer puts the
  `prism` (terminal UI) and `prism-server` (runtime) binaries on your machine
  and runs the runtime as a background service (launchd / systemd / Scheduled
  Task). Best for everyday local use.
- **[Mirantis Agent Platform](agent-platform.md)** — run the agent in a
  platform sandbox: sign-in, model credentials, ports and tools.

## Interfaces

How you talk to the agent.

- **[Web UI](web-ui.md)** — the browser UI served by the runtime: chat, threads,
  agent profile, scheduled tasks, heartbeat controls, and Slack linking.
- **[Chat socket protocol](websocket-protocol.md)** — for writing a client of your
  own: how to connect, send messages and catch up after a dropped connection.
- **[Computer link protocol](computer-link-protocol.md)** — for writing the client
  that connects a computer of yours, so the agent can use it.
- **[Slack router protocol](slack-router-protocol.md)** — for running a shared
  Slack app for many agents: what the router sends and what the API proxy answers.
- **[Terminal UI](terminal-ui.md)** — the `prism` TUI for chatting and managing
  the agent from the shell, including slash commands, the `--resume` picker, and
  the schedules/config panels.
- **[Editors](editors.md)** — use the agent from Zed, a JetBrains IDE or any
  other editor that supports the Agent Client Protocol.
- **[Slack](slack.md)** — run the agent in Slack DMs and channels: linking,
  threads, formatting, and Slack-triggered heartbeats.
- **[Microsoft Teams](teams.md)** — run the agent in Teams personal chats and
  channels: Azure setup, the public messaging endpoint, linking, and threads.

## Features

What the agent can do.

- **[The agent's identity](agent-identity.md)** — the markdown documents that
  define an agent: Soul, User, Memory, Vision, Agent Guide, Heartbeat, and
  Bootstrap.
- **[Memory](memory.md)** — the two-layer memory system: curated long-term
  memory plus an embedding-indexed searchable store.
- **[Compaction](compaction.md)** — how long conversations stay inside the
  model's context window: older history is folded into a summary automatically
  (or with `/compact`) while the newest messages stay verbatim.
- **[Heartbeat](heartbeat.md)** — the always-on monitoring loop, where it may
  post, and Slack triggers.
- **[Scheduled tasks](scheduled-tasks.md)** — putting one-shot and recurring
  work on the agent's calendar with natural language or cron; a run with
  nothing to report posts nothing.
- **[Webhooks](webhooks.md)** — named HTTP endpoints external systems
  (Alertmanager, PagerDuty, GitHub, …) POST events to, triggering an agent run
  or a direct notification.
- **[Agent messages](agent-messages.md)** — the agent receives messages from
  other agents and answers them.
- **[Voice meetings](voice-meetings.md)** — the agent joins a Google Meet call and
  takes part by voice, listening, speaking and using its tools live.
- **[Voice chat](voice-chat.md)** — a direct voice conversation with the agent, with
  no meeting in it, over the connection chat already uses.
- **[Dictation](dictation.md)** — speak a message instead of typing it; the words
  arrive in the chat as your message.
- **[The agent's computer](computer.md)** — a page where the agent has a browser and
  a desktop, you watch it work, and you can take the keyboard or share your screen.
- **[Skills](skills.md)** — installable `SKILL.md` capability bundles (the
  agentskills.io standard) the agent uses automatically, from a global directory
  or a repository's own `.claude/skills`.
- **[Plugins](plugins.md)** — installable folders (the agent-plugins.org
  standard) that bundle skills together with the MCP tool servers they need.
- **[Tools](tools.md)** — everything the agent can call: memory, self-management,
  scheduling, skills, shell, file sharing, and the coding sub-agent.
- **[Spending](spending.md)** — what the agent spends on models, per day, week or
  month, per conversation and per message.

## Reference

- **[Configuration](configuration.md)** — every environment variable the
  runtime reads, with defaults.
- **[CLI reference](cli-reference.md)** — `prism` flags, slash commands, keyboard
  shortcuts, and the `~/.prism/settings.json` file.

## How it runs

One container, one agent. The embedded database holds everything: agent
identity, conversation history, memory, scheduled
tasks, and Slack mappings. When you install natively it lives under your install
directory; in Docker it lives in the `/data` volume at `/data/agent.db`. There
is no separate datastore to stand up — back up that one file and you've backed
up the whole agent.
