# Security Policy

Prism Agent is security-sensitive software. It runs an autonomous LLM agent that
invokes powerful tools on a user's behalf — kubectl, GitHub, and AWS via MCP —
holds credentials for Slack and AWS Bedrock, and owns its own conversation and
memory store. Credential handling, the MCP tool surface, agent access control,
and the boundaries between agents are all security boundaries.

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
- Environment details: deployment mode (single-agent vs. multi-tenant), runtime
  version, and the channel involved (WebSocket, Slack, heartbeat, or cron)
- Whether the issue involves credential exposure, cross-agent access, MCP tool
  abuse, or prompt-driven exfiltration

We will acknowledge reports as quickly as practical and coordinate remediation
before public disclosure.

## Security Scope

Security-sensitive areas include:

- **The MCP tool surface** — the internal MCP server (memory, config, cron) and
  the external Nexus MCP (kubectl, GitHub, AWS). Whether the agent can be driven
  to invoke a tool, or reach a resource, beyond what its configuration intends.
- **The WebSocket gateway** — the backend verifies the JWT and proxies the
  upgrade; the runtime only decodes it. Whether a forged or replayed token can
  reach `conversationEngineService.chat()`.
- **The management and internal API surface** (`/agents/*`, `/internal/api/*`) —
  whether an unauthenticated or cross-tenant caller can drive heartbeat, cron,
  Slack, or thread operations.
- **Prompt-driven actions** — whether untrusted content arriving over a channel
  (Slack message, thread history) can steer the agent into unsafe tool use or
  data exfiltration.

## Security Boundaries

The intended boundary is: each agent runs scoped to its own `AGENT_ID` and its
own data store; credentials stay in env and on the `Authorization` header, never
in prompts, logs, or message bodies; access to an agent is gated by ownership and
the backend's access-control check; and MCP tools are exercised only within the
agent's configured intent.

When in doubt, treat any change touching credential handling, the MCP tool
surface, agent access control, agent isolation, or the API surface as
security-sensitive.
