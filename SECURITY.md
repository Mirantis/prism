# Security Policy

Prism Agent is security-sensitive software. It runs an autonomous LLM agent that executes shell
commands and edits files on the host it runs on, and reaches external systems through MCP — kubectl,
GitHub and AWS through the Mirantis Agent Platform MCP server, plus whatever an installed Agent Plugin adds. It
holds credentials for Slack, for its model provider, and — when voice meetings are enabled — for OpenAI
and a Google account. It owns its own conversation, memory and attachment store. Credential
handling, the tool surface, the network surface, and what untrusted input can drive the agent to do
are all security boundaries.

## Reporting Vulnerabilities

Please do not open a public issue for suspected vulnerabilities.

Report security issues by emailing:

```text
security@lenshq.io
```

Include as much detail as possible:

- Affected component or file path, if known
- Impact and the security boundary you believe is crossed
- Reproduction steps or proof of concept
- Environment details: how the runtime is deployed (container, native install, or SEA binary),
  which `LLM_PROVIDER` is configured, whether it reaches the model directly or through the Mirantis
  Agent Platform gateway, the runtime version, and the channel involved (WebSocket, Slack, webhook,
  heartbeat, cron, or a voice meeting)
- Whether the issue involves credential exposure, tool abuse, or prompt-driven exfiltration

We will acknowledge reports as quickly as practical and coordinate remediation before public
disclosure.

## Security Scope

Security-sensitive areas include:

- **The built-in tool surface** — the tools the runtime registers in-process: shell execution and
  file editing (`shell_exec`, `shell_write_file`, `shell_edit_file`, `coding_agent`), memory, agent
  configuration, cron, goals, skills, attachments, file sharing, and meetings. The shell tools run
  with the runtime's own privileges, so anything that can steer the agent can reach them.
- **The MCP tool surface** — the external Mirantis Agent Platform MCP server (kubectl, GitHub, AWS) and the MCP
  servers an installed Agent Plugin declares. Whether the agent can be driven to invoke a tool, or
  reach a resource, beyond what its configuration intends. Plugin servers are started as child
  processes from the plugins directory, so what is placed in that directory is a trust decision.
- **The network surface** — the runtime authenticates nothing itself, and assumes the platform in
  front of the container terminates auth. The WebSocket gateway pins every connection to the
  configured owner without inspecting a token, and the HTTP API (`/agents/*`, `/threads`,
  `/messages`, `/latest-thread`, `/agents/webhooks/:name`, `/api/ws`) has no authentication
  middleware. Any unintended network exposure therefore lets a caller drive chat, heartbeat, cron,
  Slack, webhook or thread operations directly.
- **Webhook intake** — `POST /agents/webhooks/:name` accepts JSON from external systems, and an
  agent-mode subscription turns that payload into a model invocation. No signature is verified, so
  a reachable endpoint is an unauthenticated path into the agent's prompt.
- **Prompt-driven actions** — whether untrusted content arriving over a channel (a Slack message,
  thread history, a tool result, a webhook payload) can steer the agent into unsafe tool use or
  data exfiltration.
- **Voice meetings** — in a call the Realtime model carries the agent's real tools, and the runtime
  does not authenticate the people in the room. The in-meeting prompt's confirmation rule is the
  only guard, self-configuration included, so a sentence agreed in a call can change the agent for
  later turns on every channel.
- **Credential handling** — tokens arrive through the environment and must stay on request headers,
  never in prompts, logs, tool results, or message bodies. Some secrets may be Mirantis Agent Platform
  credential sentinels that only the gateway can resolve; the Slack client strips the request
  body's `token` field so Slack auth rides the `Authorization` header alone.

## Security Boundaries

The intended boundary is: one container owns exactly one agent, identified by `AGENT_ID`, with its
own embedded database and data directory; credentials stay in the environment and on request
headers; the tool surface is exercised only within the agent's configured intent; and the runtime is
never exposed directly to an untrusted network, because it performs no authentication of its own.

When in doubt, treat any change touching credential handling, the tool surface, the HTTP or
WebSocket surface, webhook intake, or the meeting path as security-sensitive.
