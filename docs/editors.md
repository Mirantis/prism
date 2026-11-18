# Editors

You can use your Prism agent from an editor that supports the
[Agent Client Protocol](https://agentclientprotocol.com) (ACP), such as Zed or a
JetBrains IDE. The agent works in the project the editor has open, with the
memory, skills and tools it has everywhere else, and the conversation also shows
in the [Web UI](web-ui.md) and the [Terminal UI](terminal-ui.md).

The editor starts `prism acp`, which connects to the Prism runtime on your
machine. [Install Prism natively](installation.md) first.

## Zed

Add Prism to `agent_servers` in Zed's `settings.json`, then start a Prism thread
from the agent panel:

```json
{
  "agent_servers": {
    "Prism": {
      "type": "custom",
      "command": "prism",
      "args": ["acp"]
    }
  }
}
```

## JetBrains IDEs

In AI Chat, choose **Add Custom Agent** and add Prism to `~/.jetbrains/acp.json`:

```json
{
  "agent_servers": {
    "Prism": {
      "command": "prism",
      "args": ["acp"]
    }
  }
}
```

## Other clients

Any ACP client that starts its agent as a command uses the same two values: the
command `prism` and the argument `acp`.

## Working with the agent

- **A new session is a new conversation** rooted in the editor's project folder,
  where the agent runs its commands and edits files. When the agent keeps
  [one conversation](web-ui.md#one-conversation), every session is that
  conversation, and its commands run where that conversation started.
- **Earlier sessions** of the project are listed by the editor, and one reopens
  with its history.
- **A message you send while the agent works** goes to the turn in progress, as
  in the [Terminal UI](terminal-ui.md#chatting).
- **A file you mention** reaches the agent as its path, and the agent reads the
  file from disk. Save the file first. **An image** reaches it as an attachment.
- **A file the agent shares** shows as a link that downloads it.
- **The agent uses the tools set up in Prism.** To give it an MCP server, install
  a [plugin](plugins.md) that declares it.

## When it goes wrong

- **"the Prism server at … did not answer"**: the runtime is not running. Start
  [the background service](installation.md#the-background-service).
- **The editor cannot find `prism`**: give the full path as the command. `which
  prism` prints it.
- **The runtime is at another address**: set `PRISM_HTTP_URL` in the agent's
  `env` in the editor's settings, as for the
  [terminal UI](cli-reference.md#connecting-to-the-runtime).
