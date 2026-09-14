# Prism plugins

A Prism plugin adds a page to the web UI. It can also add HTTP endpoints that
page calls, tools the agent uses in chat, and work on a schedule.

You do not write one yourself. Ask the agent in chat:

> Build me a page that shows our cloud spend by service.

The agent writes the plugin, and the page appears in the navigation on the left
alongside Chat, Scheduled Tasks and the rest.

> [!WARNING]
> A plugin runs with the agent's own access: its page runs in the web UI and its
> backend runs inside the runtime, with the runtime's credentials and its files.
> Install only plugins you trust, and read what the agent wrote before you keep
> it.

## Where plugins live

One directory per plugin under `prism-plugins` in the agent's data directory —
`/data/prism-plugins` in Docker, `~/.prism/prism-plugins` when installed
natively. To remove a plugin, delete its directory. To install one somebody
shared with you, drop the directory in.

Each plugin keeps its own data under `prism-plugin-data`, a sibling directory,
so deleting and re-adding a plugin leaves its data intact.

## Some changes restart the agent

Changing what a plugin *shows* takes effect straight away. Adding or removing a
plugin, or changing the part that runs inside the agent, restarts it — the agent
waits until it is idle first, so a reply in progress is never cut off, and the
web UI says what is happening and reconnects on its own.

**In Docker, give the container a restart policy** or it will stop instead of
coming back:

```bash
docker run -d --restart unless-stopped ...
```

A native install already restarts itself. Where it cannot — on Windows, or when
you are running from source — the agent stays up and the web UI asks you to
restart it, rather than going down.

## When a plugin does not work

A plugin whose page has an error still appears in the navigation, and its page
shows what went wrong. That message is what the agent needs to fix it — paste it
into chat and ask.

A plugin missing from the navigation entirely has a malformed
`prism-plugin.json`; the agent can read the runtime's log to find out why.

## Prism plugins and Agent Plugins

Two different things with similar names. [Agent Plugins](plugins.md) are a
portable format for packaging skills and tool servers, shared across agents.
Prism plugins are Prism's own: they add pages and endpoints to this runtime, and
they do not work anywhere else.
