# Sessions & safety

A long-lived agent that can run shells and act on its own needs guardrails: a
way to keep context from compounding forever, hard limits that bound every turn,
and visibility into what it's doing. This page covers all three.

## Sessions and idle handling

The agent persists between conversations, but it doesn't carry one
ever-growing context indefinitely. Two mechanisms give it clean breaks:

- **Daily reset.** Once a day (default **4 AM** in the agent's configured
  timezone) the conversation context resets — a fresh "day." Older messages are
  archived; **memory persists across the reset** (that's the whole point of
  [memory](memory.md) being separate from conversation context).
- **Idle timeout.** Optionally, a period of user inactivity also starts a fresh
  context. This is off unless configured.

Resets affect conversation context only — the agent's identity, memory,
scheduled tasks, and Slack links are untouched.

## Safety controls

Every turn is bounded so the agent can't run away:

- **Step limit — 100 steps.** A single turn is capped at 100 tool-use steps.
  When the agent hits the cap, it makes one final tool-less call asking itself
  to summarize what it found, rather than looping further. You get a useful
  answer instead of a runaway.
- **Output cap — 16,000 tokens** per generation.
- **Per-tool output limits.** Large tool outputs (a noisy command, a big file)
  are truncated before they reach the model — head and tail are kept with an
  omission notice — so one tool call can't flood the context window. Shell
  output is capped per call (default ~10 KB, adjustable up to 10 MiB) and per
  command timeout (up to 20 minutes).
- **File limits.** Attachments are capped at **10 MB** each and **100 per
  message**; very large text files are truncated when inlined into context
  (the full file is still stored).
- **Workspace confinement.** The agent's [shell tools](tools.md#shell) operate
  inside a workspace directory and can't escape it with `../` or stray absolute
  paths.
- **Heartbeat fail-open gate.** The [heartbeat](heartbeat.md) gate runs cheap
  programmatic checks first (empty response, 24-hour exact duplicate) and only
  then the LLM gate; if the gate errors, the alert is delivered rather than
  lost.

For the strongest network boundary — every outbound connection the agent (or its
shell tools) makes checked against a policy — run Prism under
**[Lens Sandbox](lens-sandbox.md)**.

## Observability

You can see what the agent is doing at three levels:

- **Structured logs.** The runtime emits JSON logs (Pino) by default — to
  stdout/stderr, and to `~/.prism/server.log` on a native macOS install.
- **Langfuse tracing.** Set the Langfuse keys (see
  **[Configuration](configuration.md)**) and every LLM call is traced — model,
  tokens, tool calls, latency. Disabled when the keys are unset.
- **OpenTelemetry export.** Point `OTEL_EXPORTER_OTLP_ENDPOINT` at a collector
  to export product telemetry — heartbeat and cron lifecycle events, config
  changes, message feedback, and more. Disabled when no endpoint is set.

All three are optional and off by default (beyond the local logs); turn on only
what you need.
