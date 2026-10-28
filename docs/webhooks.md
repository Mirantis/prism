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

Webhooks are off by default. Turn on **Webhook receiver** on the
[Web UI](web-ui.md) **Webhooks** page to open the webhook port; turning it off
closes the port immediately and keeps your subscriptions. The setting survives restarts.

If enabling reports that the port is in use, choose a free `WEBHOOK_PORT`, restart,
and enable the receiver again. An enabled receiver retries at the next restart.

## Creating a subscription

Click **New subscription** on the Webhooks page. **Delivery** and
**Authentication** are separate sections in the form:

| Section | Field | Meaning |
|---------|-------|---------|
| — | **Name** | Lowercase slug (`[a-z0-9][a-z0-9_-]*`); becomes the endpoint path `/agents/webhooks/<name>`. Spaces are normalized to hyphens. |
| — | **Description** | What this webhook does (optional, shown in the list). |
| — | **Events** | Comma-separated event-type allowlist; empty = accept all. See [Event filtering](#event-filtering). |
| Delivery | **May post to** | Where the run may post: **All channels** (default — web chat, Slack and Teams, like heartbeat alerts), **Chat** (web chat only), **Slack** (Slack only), **Microsoft Teams** (Teams only), or **None** (nowhere) — see [Delivery targets & storage](#delivery-targets--storage). |
| Delivery | **Slack channels** | Shown when **May post to** is **Slack**: the linked channels to post to. With none checked, the message goes to your DM, else the main channel. |
| Delivery | **Deliver only** | Skip the agent: the rendered prompt template is posted directly as the message. Zero LLM cost — useful for plain notifications. |
| Delivery | **Prompt** / **Message template** | Instructions for the agent, or the message sent in **Deliver only** mode. Supports payload substitution — see below. |
| Authentication | **Scheme** | How the sender proves itself: **Shared token in a header** (default), **HMAC signature of the body**, or **None**. |
| Authentication | **Header** / **Prefix** / **Secret** (+ **Algorithm** / **Encoding** / **Signed URL**) | Where the credential arrives and what it's compared against; shown once Scheme isn't None. See [Authentication](#authentication). |

Each row in the subscriptions list shows the endpoint path with a button that
copies its full URL, an **Active** switch (disabled subscriptions answer `401`
without running anything), an **Edit** action, and a delete action. **Edit**
opens the same form; the name is the endpoint path and stays fixed, so create a
new subscription for a new path. Changes apply immediately.

In the [terminal UI](terminal-ui.md#webhooks-panel-webhooks), `/webhooks` pauses
and resumes subscriptions and edits their description, events, delivery and
prompt.

## The endpoint

Senders POST to the webhook port, **3004**, apart from the Web UI and its API
on 3003. `WEBHOOK_PORT` moves it; use a different port from `PORT`. In Docker,
publish it with `-p 3004:3004`.

Expose the webhook port through your ingress or tunnel. When a public address is
configured, **Copy endpoint URL** copies it. Otherwise, a remotely opened Webhooks
page shows the endpoint path. Combine that path with your public ingress or
tunnel URL.

```
POST http://<prism-host>:3004/agents/webhooks/<name>
Content-Type: application/json
```

The body must be a JSON object. Responses (`event` is the resolved event type —
see [Event filtering](#event-filtering)):

| Status | Meaning |
|--------|---------|
| `202 Accepted` | Agent run dispatched: `{"status":"accepted","event":"<type>","runId":"..."}`. The response is delivered to your channels when the run finishes. |
| `200 OK` | Deliver-only message posted: `{"status":"delivered","event":"<type>"}` — or the event was filtered out by the Events list: `{"status":"ignored","event":"<type>"}`. |
| `400` | Body was not a JSON object. |
| `401` | Check the subscription name, its Active switch, and the sender credentials. See [Authentication](#authentication). |
| `429` | This subscription's run queue is full — retry later. |

Agent runs are asynchronous by design — webhook senders like Alertmanager time
out quickly and retry on non-2xx, so the endpoint never holds the connection
open while the agent works. The agent's response arrives in the conversation
on the subscription's delivery target. If the run fails outright, a brief
failure notice is delivered there instead, so a triggered event never
disappears silently. Every accepted event is also listed on the
[Activity page](web-ui.md#activity) with its result.

**Runs are serialized per subscription**: concurrent deliveries are accepted
(`202`) and queued, then executed one at a time in arrival order — so rapid
distinct events are never dropped, even from senders that don't retry on
non-2xx (GitHub never redelivers automatically). The queue is capped
(10 pending); beyond that, deliveries answer `429` as a backstop against
pathological floods. Deliver-only requests are not queued or limited — they
cost no LLM tokens. A queued or running event survives a restart, and runs when
the runtime is back.

## Authentication

Expose the webhook port to your senders and keep port 3003 private: anyone who
reaches 3003 controls the agent through the Web UI and its API. **Each
subscription can require its sender to prove itself**, which is what stops
anyone who can reach the endpoint (and guess the name) from triggering agent
runs with a payload they control.

Verification is **generic**: instead of a list of supported vendors, you point
it at the header your sender uses and pick how the credential is compared. Any
sender is then a matter of configuration.

| Scheme | What must match |
|--------|-----------------|
| **None** | Accepts unsigned requests. Select this explicitly to allow any sender. The list shows `Unverified`. |
| **Shared token in a header** (default) | The chosen header carries the secret verbatim (after an optional prefix). |
| **HMAC signature of the body** | The chosen header carries `HMAC(secret, raw request body)` in the chosen digest + encoding (after an optional prefix). |

The parameters:

| Field | Meaning |
|-------|---------|
| **Header** | Header name that carries the credential, e.g. `X-Hub-Signature-256` or `Authorization`. Matched case-insensitively. |
| **Prefix** | Optional literal stripped from the header value before comparing, e.g. `sha256=`, `v1=`, `Bearer`. Any space between the prefix and the credential is ignored, and a value that arrives without the prefix at all is still accepted. |
| **Secret** | The shared secret / HMAC key. Write-only: the API returns whether a secret is set, never the value. |
| **Algorithm** / **Encoding** | HMAC only: `sha256` (default), `sha1` or `sha512`, encoded as `hex` (default, case-insensitive) or `base64`. |
| **Signed URL** | HMAC only, optional: for a sender that signs the body followed by its webhook URL. Enter the exact URL configured in the sender. |

- **Multiple signatures are supported**: an HMAC header may carry several
  comma-separated candidates and the request passes if any matches — that's how
  senders that emit both an old and a new signature during a secret rotation
  keep working. Token mode compares the whole value, so a token may contain a
  comma.
- Set both **Header** and **Secret** when creating a verified subscription.
- **Rotating a secret** doesn't need a new endpoint: open **Edit** on the
  subscription, enter the new secret, and save. Leaving the field empty keeps
  the current one.
- The secret is stored in the agent's own database.

### Recipes for common senders

| Sender | Scheme | Header | Prefix | Notes |
|--------|----------------|--------|--------|-------|
| GitHub | HMAC | `X-Hub-Signature-256` | `sha256=` | Paste the same value into GitHub's webhook **Secret** field. |
| GitLab | Shared token | `X-Gitlab-Token` | — | GitLab's **Secret token** field; it sends the token as-is, no HMAC. |
| PagerDuty | HMAC | `X-PagerDuty-Signature` | `v1=` | Uses the signing secret shown when the v3 webhook subscription is created; sends several `v1=` signatures while rotating. |
| Alertmanager | Shared token | `Authorization` | `Bearer` | Configure `http_config.authorization` on the receiver (see below). |
| Trello | HMAC | `X-Trello-Webhook` | — | Algorithm `sha1`, Encoding `base64`, **Signed URL** = the `callbackURL` (see below). |
| Anything with a base64 HMAC | HMAC | (their header) | — | Set Encoding to `base64`. |
| Custom scripts | Shared token | any header you like | — | Simplest option for internal senders. |

## Delivery targets & storage

Each subscription's **May post to** setting is where an agent run may post. The
agent posts only what the prompt asks for, to the place the prompt names inside
this setting, else to your DM, else the main channel, else web chat. A
**Deliver only** message and a failed run are posted for you, and this setting
controls both where that message is sent and where it's recorded:

- **All channels** (default) — broadcast, exactly like a heartbeat alert: the
  message appears in web chat and is sent to every linked integration. On
  Slack and Teams that means your **DM** (personal mode) or the agent's
  **main channel** (team mode — the one flagged on the
  [Channels page](web-ui.md#channels), else the oldest linked channel), not
  every linked channel.
- **Chat** — web chat only; nothing is sent to Slack or Teams.
- **Slack** — Slack only. The message is delivered to your DM (personal mode)
  or the main channel (team mode) and is **kept out of web chat**: it's stored
  in that Slack destination's own conversation thread (the DM conversation in
  personal mode; a dedicated per-channel thread in team mode), which the web
  Recents list and CLI resume picker don't show. If no Slack DM or channel is
  linked, the message goes to web chat only (and the runtime logs a
  warning) so a triggered event is never silently lost. With **Slack
  channels** checked, the message goes to each checked channel instead, stored
  in that channel's own thread. A checked channel that is unlinked later gets
  nothing; when none of them is still linked, the message goes to web chat.
- **Microsoft Teams** — Teams only; same semantics as the Slack target, using
  the Teams personal chat or main channel.
- **None** — the agent runs and posts no message, even when the run fails. Use
  it when the agent's work lands somewhere else, such as a review on GitHub.

When an agent run posts a message, web chat keeps a record of that run.

Put the condition in the prompt, for example "Review the PR. Message me only if
the review finds a blocking problem." A prompt that asks for a message on every
event, or an empty prompt, gets one every time. A failed run is always posted,
except with **None**.

## Prompt templates

An empty Prompt sends the agent the raw payload as pretty-printed JSON with an
event/route lead-in — the agent reasons over the full event. Alertmanager and
PagerDuty payloads work well this way with no template at all.

A non-empty Prompt is rendered against the payload first:

- `{field.path}` — dot-notation access into the payload, e.g.
  `{commonLabels.alertname}` or `{pull_request.title}`. Unresolvable keys are
  left as-is.
- `{__raw__}` — the entire payload as indented JSON (truncated to ~4000 chars).

The agent follows your Prompt as your instructions and treats text filled in
from the payload as data.

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
      - url: http://<prism-host>:3004/agents/webhooks/alertmanager
        send_resolved: true
        # Matches a subscription with Scheme = shared token in a header,
        # Header = Authorization, Prefix = Bearer.
        http_config:
          authorization:
            type: Bearer
            credentials_file: /etc/alertmanager/prism-webhook-secret
route:
  receiver: prism
```

Alertmanager groups alerts and sends one JSON payload per group (with
`status`, `commonLabels`, and an `alerts` array) — the raw-payload default
prompt handles it well. Alertmanager retries on non-2xx and re-notifies on
`repeat_interval`; per-subscription run serialization keeps that from fanning
out into concurrent agent runs, without dropping distinct alert groups.

**PagerDuty** — create a v3 webhook subscription (Integrations → Developer
Tools → Webhooks) pointing at
`http://<prism-host>:3004/agents/webhooks/pagerduty`. Events arrive as
`{"event": {"event_type": "incident.triggered", ...}}`. Copy the signing secret
shown at creation time into the subscription's Secret field with
Scheme = HMAC, Header = `X-PagerDuty-Signature`, Prefix = `v1=`.

**GitHub** — add a repository webhook (Settings → Webhooks) with content type
`application/json` pointing at
`http://<prism-host>:3004/agents/webhooks/github`. Put the same string in
GitHub's **Secret** field and in the subscription's Secret field with
Scheme = HMAC, Header = `X-Hub-Signature-256`, Prefix = `sha256=`. Use
the Events field (e.g. `pull_request,issues`) to pick the event types you care
about.

**Trello** — create the webhook with Trello's REST API. Enable the receiver
first: Trello checks the URL when the webhook is created. In the subscription,
set Scheme = HMAC, Header = `X-Trello-Webhook`,
Algorithm = `sha1`, Encoding = `base64`, Signed URL = the same `callbackURL`, and
Secret = the API secret from your Trello Power-Up admin page. Leave Events empty:
the Events filter cannot match a Trello delivery.

```bash
curl -X POST "https://api.trello.com/1/webhooks/?key=$TRELLO_KEY&token=$TRELLO_TOKEN" \
  -d callbackURL="https://<prism-host>/agents/webhooks/trello" \
  -d idModel="<board id>" \
  -d description="Prism"
```

`{action.type}`, `{action.data.card.name}`, `{action.memberCreator.fullName}`
and `{model.name}` are useful template fields.

**Anything else** — any system that can POST JSON works. With Scheme = **None**:

```bash
curl -X POST http://<prism-host>:3004/agents/webhooks/my-hook \
  -H 'Content-Type: application/json' \
  -d '{"event_type": "deploy.finished", "service": "api", "version": "1.4.2"}'
```

With a shared token (Header = `Authorization`, Prefix = `Bearer`):

```bash
curl -X POST http://<prism-host>:3004/agents/webhooks/my-hook \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $PRISM_WEBHOOK_SECRET" \
  -d '{"event_type": "deploy.finished", "service": "api", "version": "1.4.2"}'
```

With an HMAC signature (Header = `X-Hub-Signature-256`, Prefix = `sha256=`) —
sign the exact bytes you send:

```bash
BODY='{"event_type":"deploy.finished","service":"api"}'
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$PRISM_WEBHOOK_SECRET" | awk '{print $2}')
curl -X POST http://<prism-host>:3004/agents/webhooks/my-hook \
  -H 'Content-Type: application/json' \
  -H "X-Hub-Signature-256: sha256=$SIG" \
  -d "$BODY"
```
