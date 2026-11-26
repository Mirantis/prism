# Mirantis Agent Platform

Mirantis Agent Platform runs Prism Agent in a sandbox. The platform signs people
in, supplies the model credentials and the project's tools, and gives each
exposed port a public address. Create the agent from the platform's Prism
template. The agent then runs with no LLM key, Slack token or other secret in
its sandbox.

## Sign-in

The platform signs people in before a request reaches the agent. Everyone the
platform lets through is the agent's owner, so the Web UI and the terminal UI
ask for no login of their own. Control access to the agent in the platform.

## Models

The template sets `LLM_PROVIDER` to the inference backend that the project's
policy selects. Chat and memory embeddings go through the platform's LLM
gateway, which holds the credentials. To change the backend, change the
project's policy, not the agent.

The `anthropic` provider is the exception: it does not use the gateway, so it
always needs `ANTHROPIC_API_KEY`. See [Configuration](configuration.md#provider-selection)
for each provider.

## Ports

Expose a port in the agent's revision for each surface you use:

| Port | Name | Access | For |
|------|------|--------|-----|
| `3003` | `web` | `private` | The Web UI, the terminal UI and the chat API |
| `3004` | any | `public` | [Webhooks](webhooks.md) |
| `3979` | `teams` | `public` | [Microsoft Teams](teams.md) |

The agent uses each port's public address in the links it sends, such as file
links in Teams, and on the **Webhooks** page. Set `PRISM_PUBLIC_URL` to use a
different address for the Web UI.

## Credentials

Keep each secret in the platform and grant it to the sandbox under the
variable's name. The sandbox then holds only a placeholder, and the platform
puts the real value in the request as it leaves the sandbox. This works for
every credential the agent sends in a request header: the LLM keys,
`SLACK_BOT_TOKEN` and `TEAMS_APP_PASSWORD`.

`GOOGLE_BOT_PASSWORD` for [voice meetings](voice-meetings.md) must be the real
password, because the agent types it into Google's sign-in page.

## Tools

The agent gets the project's tools, such as kubectl, GitHub and AWS, from the
platform's MCP server. They appear beside the built-in tools; see
[External tools](tools.md#external-tools-mcp).

## Voice

Enable managed OpenAI or Azure in the project's policy to give the agent a
Realtime credential. [Voice chat](voice-chat.md), [voice meetings](voice-meetings.md)
and [voice messages](dictation.md) use it, whatever backend runs chat.

## Troubleshooting

- **The Webhooks page shows only a path.** The webhook port is not exposed.
- **The voice tools are missing.** The project's policy has no managed OpenAI
  or Azure, and no `OPENAI_REALTIME_API_KEY` is set.
- **A tool call fails with a network error.** The sandbox's network policy
  blocks the host. Allow it in the platform.
- **A coding task's result says it ran without an MCP server's tools.** The
  sandbox's network policy may block the server's host. For a claude.ai
  connector, allow `mcp-proxy.anthropic.com`.
