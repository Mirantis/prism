# Heartbeat

The heartbeat is the agent's always-on monitoring loop. On a schedule, the agent
wakes up, runs the checks you've configured, and decides — on its own — whether
anything is worth telling you about. It's what makes the agent proactive rather
than purely reactive.

## How it works

On each tick the agent:

1. Runs the checks defined in its **Heartbeat** document (see
   **[The agent's identity](agent-identity.md)**), using its full toolset.
2. Posts a message only when a check finds something you need to know (see
   [Where a check posts](#where-a-check-posts)).

You configure *what* it checks by editing the Heartbeat document (just tell the
agent what to watch). You configure *how often* with the interval.

A check can also schedule a follow-up, such as "if the deploy is still running,
check again in 30 minutes", which then runs as a [scheduled task](scheduled-tasks.md).

The check itself runs on the agent's main model by default, but you can give
the heartbeat its own model — useful for running routine checks on a cheaper
model. Set it from the **[Web UI → Profile](web-ui.md#profile)** or the
**[Terminal UI](terminal-ui.md#slash-commands)** (`/heartbeat-model <id>`); leave
it empty to use the main model.

## Cadence

- **Default interval:** every **8 hours**.
- **Configurable per agent**, with a minimum of 1 minute.

Set it from the **[Web UI → Profile](web-ui.md#profile)** (an inline editor,
1–10080 minutes), from the **[Terminal UI](terminal-ui.md#heartbeat)** with
`/heartbeat every 2h`, or just by asking the agent.

The interval counts from the last check, so a restart does not postpone the next
one. An agent that comes back with a check already due runs it about a minute
later. Changing the interval starts a new interval from that moment.

## Where a check posts

A heartbeat posts a message only when a check finds something you need to know,
and a check that finds nothing stays silent. The next heartbeat sees what the
earlier ones posted, and posts again only for a new finding or a change.

**May post to** under Heartbeat Status on the [Profile page](web-ui.md) sets
where a heartbeat may post: every linked channel and web chat (the default), web
chat only, Slack or Teams, chosen Slack channels, or nowhere. A check that names
a place inside that setting posts there; otherwise the heartbeat posts to your
DM, else the main channel, else web chat. A check that fails with an error is
posted for you to the same place.

## Controlling the heartbeat

| Where | How |
|-------|-----|
| Web UI | Profile page: **Start**, **Stop**, **Trigger now**, edit interval |
| Terminal UI | `/heartbeat status \| start \| stop \| trigger \| every <N>m\|<N>h` |
| Conversation | Ask the agent to start/stop it, change cadence, or add/remove checks |

If the heartbeat hits repeated errors, the agent backs off and stops the loop
rather than spinning on a broken check (a spending-limit error is treated as
transient — it skips that tick without counting against the error streak).

## Slack-triggered heartbeats

Heartbeats don't only run on a timer — they can also be **woken by Slack
activity**. Designate a Slack channel as a heartbeat trigger (from the
**[Web UI → Channels](web-ui.md#channels)** page), and incoming messages in
that channel wake the heartbeat with those messages as context. This lets the
agent react to real-time events between scheduled runs.

- A per-channel **throttle** caps how often this can fire, so a busy channel
  doesn't trigger the agent constantly.
- Messages are **queued and drained atomically**, so nothing is lost — even if
  several arrive while the agent is mid-run, they're picked up on the next pass.

See **[Slack](slack.md#slack-triggered-heartbeats)** for the channel setup.

## What an alert looks like

When the agent does deliver, the alert goes to your active conversation (and, if
configured, broadcasts to connected channels like Slack, labeled as a heartbeat).
It reads like any other agent message — the finding, in plain language, with
whatever detail the check produced.
