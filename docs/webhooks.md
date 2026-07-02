# Webhooks

External systems can trigger the agent by POSTing to a named webhook endpoint.
Where the [heartbeat](heartbeat.md) polls on a timer and
[scheduled tasks](scheduled-tasks.md) run on a calendar, a webhook is
**push**: Alertmanager fires an alert, PagerDuty opens an incident, GitHub
merges a PR — and the agent reacts immediately, no cadence involved.

Each webhook is a **subscription**: a named route with its own endpoint URL, an
optional prompt template, and a delivery target. When an event arrives, the
agent reasons over the payload (or, in deliver-only mode, the rendered template
is posted directly with no LLM call) and the result is delivered to your
connected channels.

## Enabling the receiver

Webhooks are off by default. Open the **Webhooks** page in the
[Web UI](web-ui.md) and click **Enable Webhooks**. The toggle takes effect
immediately — no restart. While the receiver is disabled, every webhook
endpoint answers `403`.

## Creating a subscription

Click **New subscription** on the Webhooks page:

| Field | Meaning |
|-------|---------|
| **Name** | Lowercase slug (`[a-z0-9][a-z0-9_-]*`); becomes the endpoint path `/agents/webhooks/<name>`. Spaces are normalized to hyphens. |
| **Description** | What this webhook does (optional, shown in the list). |
| **Events** | Comma-separated event-type allowlist; empty = accept all. See [Event filtering](#event-filtering). |
| **Deliver to** | Where results go: **All channels** (default — web chat + Slack, like heartbeat alerts), **Chat** (web only), or **Slack** (the linked DM). |
| **Deliver only** | Skip the agent: the rendered prompt template is posted directly as the message. Zero LLM cost — useful for plain notifications. |
| **Prompt** | Instructions for the agent when this webhook fires (optional). Supports payload substitution — see below. |

Each row in the subscriptions list shows the endpoint path with a copy button,
an **Active** switch (disabled subscriptions answer `403` without running
anything), and a delete action. Changes apply immediately.

## The endpoint

```
POST /agents/webhooks/<name>
Content-Type: application/json
```

The body must be a JSON object. Responses (`event` is the resolved event type —
see [Event filtering](#event-filtering)):

| Status | Meaning |
|--------|---------|
| `202 Accepted` | Agent run dispatched: `{"status":"accepted","event":"<type>","runId":"..."}`. The response is delivered to your channels when the run finishes. |
| `200 OK` | Deliver-only message posted: `{"status":"delivered","event":"<type>"}` — or the event was filtered out by the Events list: `{"status":"ignored","event":"<type>"}`. |
| `400` | Body was not a JSON object. |
| `403` | Receiver disabled, or this subscription is disabled. |
| `404` | No subscription with that name. |
| `429` | This subscription already has an agent run in flight — retry later. |

Agent runs are asynchronous by design — webhook senders like Alertmanager time
out quickly and retry on non-2xx, so the endpoint never holds the connection
open while the agent works. The agent's response arrives in the conversation
(prefixed `**Webhook: <name>**`) on the subscription's delivery target. If the
run fails outright, a brief failure notice is delivered there instead, so a
triggered event never disappears silently.

**One run at a time per subscription**: while an agent run is in flight,
further POSTs to the same subscription answer `429` (senders that retry on
non-2xx will simply deliver later). This bounds LLM spend when a sender
re-notifies aggressively or an alert flaps. Deliver-only requests are not
limited — they cost no LLM tokens.

**Authentication**: the runtime itself does not authenticate webhook calls —
like every other runtime endpoint, auth is terminated by the platform routing
in front of the container. Don't expose the runtime port directly to the
internet.

## Prompt templates

An empty Prompt sends the agent the raw payload as pretty-printed JSON with an
event/route lead-in — the agent reasons over the full event. Alertmanager and
PagerDuty payloads work well this way with no template at all.

A non-empty Prompt is rendered against the payload first:

- `{field.path}` — dot-notation access into the payload, e.g.
  `{commonLabels.alertname}` or `{pull_request.title}`. Unresolvable keys are
  left as-is.
- `{__raw__}` — the entire payload as indented JSON (truncated to ~4000 chars).

Example, for Alertmanager:

```
An alert group just fired ({status}):

{__raw__}

Triage it: check the affected pods, look for an obvious cause, and summarize
what you found. Only suggest a remediation if you're confident.
```

In deliver-only mode the rendered template **is** the message — e.g.
`Alert: {commonLabels.alertname} is {status}` posts
"Alert: HighMemory is firing" with no agent involvement.

## Event filtering

The Events field matches the incoming event's **type**, resolved in this order:

| Source | Where the type comes from | Example values |
|--------|---------------------------|----------------|
| GitHub | `X-GitHub-Event` header | `push`, `pull_request`, `issues` |
| GitLab | `X-GitLab-Event` header | `Merge Request Hook` |
| Generic | top-level `event_type` field in the payload | whatever the sender sets |
| Anything else | — | `unknown` |

A non-empty Events list accepts only matching types; everything else answers
`200 {"status":"ignored"}` without running the agent.

> **Leave Events empty for Alertmanager and PagerDuty.** Neither sends a
> GitHub-style event header or a top-level `event_type` field, so their
> deliveries resolve to `unknown` — an Events list like `firing,resolved`
> would silently filter out every event. Put that intent in the Prompt
> instead ("only act on firing alerts; ignore resolved notifications").

## Hooking up common senders

**Alertmanager** — add a webhook receiver to `alertmanager.yml`:

```yaml
receivers:
  - name: prism
    webhook_configs:
      - url: http://<prism-host>/agents/webhooks/alertmanager
        send_resolved: true
route:
  receiver: prism
```

Alertmanager groups alerts and sends one JSON payload per group (with
`status`, `commonLabels`, and an `alerts` array) — the raw-payload default
prompt handles it well. Alertmanager retries on non-2xx and re-notifies on
`repeat_interval`; the per-subscription in-flight guard (`429` while a run is
active) keeps that from fanning out into concurrent agent runs.

**PagerDuty** — create a v3 webhook subscription (Integrations → Developer
Tools → Webhooks) pointing at
`http://<prism-host>/agents/webhooks/pagerduty`. Events arrive as
`{"event": {"event_type": "incident.triggered", ...}}`.

**GitHub** — add a repository webhook (Settings → Webhooks) with content type
`application/json` pointing at
`http://<prism-host>/agents/webhooks/github`. Use the Events field
(e.g. `pull_request,issues`) to pick the event types you care about.

**Anything else** — any system that can POST JSON works:

```bash
curl -X POST http://<prism-host>/agents/webhooks/my-hook \
  -H 'Content-Type: application/json' \
  -d '{"event_type": "deploy.finished", "service": "api", "version": "1.4.2"}'
```
