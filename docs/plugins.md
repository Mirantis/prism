# Plugins

**Agent Plugins** package capabilities into a single distributable folder. They
follow the open [agent-plugins.org](https://agent-plugins.org) standard (version
1.0.0), so a plugin written for another agent works here unchanged.

Where a **[skill](skills.md)** carries instructions, a plugin can carry
instructions *and* the tools those instructions need. A plugin contributes two
kinds of thing, which is the whole of what the standard defines:

- **Skills** — ordinary `SKILL.md` bundles, merged into the agent's skills.
- **MCP servers** — tool servers the runtime launches and exposes to the agent.

There is nothing else to configure. Drop a plugin folder in and its skills and
tools appear; delete the folder and they disappear.

## Where plugins live

Plugins are discovered from the agent's plugins directory, which lives in its
data dir: `~/.prism/plugins` for a native install, `/data/plugins` in Docker.
Override the data dir with `PRISM_DATA_DIR`, or the plugins dir specifically with
`PRISM_PLUGINS_DIR` — see **[Configuration](configuration.md)**.

Each immediate subdirectory holding a `plugin.json` is one plugin, and the folder
name is the plugin's id:

```
plugins/
└── my-plugin/            # the folder name is the plugin id
    ├── plugin.json       # required
    ├── skills/           # optional
    │   └── greet/
    │       └── SKILL.md
    └── mcp.json          # optional
```

## Installing a plugin

> **Install only plugins you trust.** A plugin's `mcp.json` can declare a stdio
> server, which the runtime starts as a **local process on this machine**, with
> the runtime's `PATH` and `HOME`. Installing a plugin is running its code. The
> subprocess does not inherit the agent's own credentials (see
> [MCP servers from a plugin](#mcp-servers-from-a-plugin)), but that is a limit
> on blast radius, not a sandbox.

Installation is out of band, exactly as it is for skills: put the folder in place
and the agent picks it up on its next turn — no restart. Clone it, copy it, or
have the agent fetch it for you with its shell tools.

Removing a plugin is deleting its folder. Its skills leave the catalog and its
MCP servers are shut down.

Data a plugin's MCP server writes lives outside the plugin folder, in
`<data dir>/plugin-data/<plugin id>/`, so replacing a plugin does not destroy its
state.

## `plugin.json`

Only `$schema` and `name` are required. The smallest valid manifest is:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  "name": "my-plugin"
}
```

`name` must be 1–64 characters of lowercase letters, digits, `-` or `.`, must
start and end alphanumeric, and must not contain `--` or `..`.

The optional fields are `version`, `description`, `author`, `homepage`,
`repository`, `license`, `keywords` and `extensions`. Anything else is reported
in the plugin's diagnostics and ignored, so a plugin carrying another agent's
settings still loads here.

## Skills from a plugin

Put each skill in its own folder under `skills/`, in the usual
[agentskills.io](https://agentskills.io) layout. Only immediate children are
scanned — nesting skills deeper does not work.

Plugin skills behave exactly like any other skill: the agent sees each one's name
and description, and loads the full instructions when a task matches. They are
listed by `/skills` and labelled `(plugin: <id>)`.

Plugin skills have the **lowest precedence**. If a plugin ships a skill whose
name you already use — in the workspace or in your own skills directory — yours
wins, and the plugin's is skipped. A plugin can add a capability but cannot
quietly replace one you installed yourself.

## MCP servers from a plugin

`mcp.json` declares the tool servers to launch:

```json
{
  "$schema": "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
  "mcpServers": {
    "probe": {
      "type": "stdio",
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server.js"],
      "env": { "MODE": "live" },
      "cwd": "${PLUGIN_DATA}"
    },
    "api": {
      "type": "streamable-http",
      "url": "https://example.com/mcp"
    }
  }
}
```

Three transports are supported: `stdio` (a local subprocess), `streamable-http`,
and the legacy `sse`.

`$schema` is optional. Most `mcp.json` files — the ones written for other agents —
omit it, and those load here unchanged; when it is absent the file is read as
Agent Plugins 1.0.0 and a note appears in `/plugins`. When it *is* present it must
name a version this runtime implements, or the file is refused.

Two things to watch, because both silently drop a server rather than the whole
file:

- **`command` takes one token.** `"command": "npx", "args": ["-y", "server"]` —
  not `"command": "npx -y server"`.
- **The remote transport is `streamable-http`**, which is the spec's name for it.
  `"type": "http"` is rejected.

Two variables are available in `args`, in `env` values, and in `cwd`:

- `${PLUGIN_ROOT}` — the plugin's own folder.
- `${PLUGIN_DATA}` — its persistent data folder, created before the server starts.

Both are also set in the server's environment. The rules worth knowing:

- `command` is a single executable: a bare name found on `PATH`, or a `./` path
  inside the plugin. Put arguments in `args`, not in `command`, and note that
  `${PLUGIN_ROOT}` is **not** substituted in `command`.
- `cwd` defaults to the plugin folder and must stay inside `${PLUGIN_ROOT}` or
  `${PLUGIN_DATA}`.
- A server does **not** inherit the agent's environment. It receives only a
  minimal set (`HOME`, `PATH`, `SHELL` and a few others) plus whatever `env`
  declares, so the agent's own credentials are never handed to a plugin.
- Do not put secrets in `env` or `headers` — a plugin folder is shared as-is, and
  the standard treats both as public package data.

A plugin's tools are named `<plugin id>__<server name>__<tool name>`, so two
plugins can expose a tool of the same name without clashing, and a plugin can
never take over a built-in tool's name. A name that comes out longer than the
model's 64-character limit is shortened to fit, so keeping the plugin's folder
name short keeps its tools' names readable.

## What the agent knows about plugins

The agent's system prompt carries a `# Plugins` section listing each installed
plugin, its version and description, the skills it contributed, and the prefix
its tools use. It also names the plugins directory — so if you ask the agent to
install a plugin, it knows where to put it and can do so with its shell tools.

The section stays short on purpose. A plugin's skills are already listed under
`# Skills`, so they are named here but not described twice, and when no plugins
are installed the whole section collapses to a single sentence.

## The `/plugins` command

Both the **[Terminal UI](terminal-ui.md)** and the **[Web UI](web-ui.md)** expose
a `/plugins` slash command (type `/` in the chat input). It lists each installed
plugin with its version and description, the skills and MCP servers it
contributes, and any problems found while loading it.

## When a plugin is broken

A bad plugin is skipped, never fatal — the agent keeps working, and the reason is
reported in `/plugins` and in the runtime log. The failure is always as narrow as
possible:

| Problem | Effect |
|---------|--------|
| `plugin.json` malformed, or the name breaks the rules | The plugin is skipped entirely. |
| Targets a spec version this runtime does not implement | The plugin is skipped; the log names the version it asked for. |
| Unknown fields in `plugin.json` | Reported and ignored; the plugin loads. |
| `mcp.json` malformed | No MCP servers load — but the plugin's skills still do. |
| One server entry invalid | That server is skipped; the others still start. |
| A server fails to start | Reported; the rest of the plugin is unaffected. |
| A `SKILL.md` missing its name or description | That skill is skipped; its siblings still load. |

## What is not supported

The standard defines skills and MCP servers, and nothing else. Plugins carrying
commands, hooks, or subagents for another agent are still valid here — those
parts are ignored rather than rejected, along with any reverse-domain extension
folders such as `com.example.client/`.

There is no plugin registry or marketplace. The standard does not define one, so
installation stays a matter of putting a folder in place.
