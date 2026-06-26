# Slack

Prism can run in Slack — responding to direct messages and channel mentions,
holding threaded conversations, and waking on activity in designated channels.
Slack runs over **Socket Mode**, so no public webhook or inbound URL is needed.

Slack is optional. The runtime starts fine without it; add it when you want it.

## Setting up the Slack app

You provide the agent with credentials for a Slack app you create:

| Variable | Value |
|----------|-------|
| `SLACK_BOT_TOKEN` | The bot token (`xoxb-…`). Validated via `auth.test` on boot. |
| `SLACK_APP_TOKEN` | An app-level token (`xapp-…`) with the `connections:write` scope, required for Socket Mode. |
| `SLACK_EXPECTED_APP_ID` | *(optional)* If set, the bot token's app ID must match — a safety check that you wired up the right app. |

On the Slack side, create an app, **enable Socket Mode**, and grant the bot the
scopes it needs to do its job — posting and reading messages, handling DMs and
mentions, uploading/reading files, reading user and channel info, and adding
reactions. A working set of bot scopes:

```
app_mentions:read   chat:write        im:history        im:read
channels:history    groups:history    files:read        files:write
users:read          reactions:write   conversations.connections:write
```

Subscribe to the bot events the agent handles: `message.im`,
`message.channels` (and `message.groups` for private channels),
`app_mention`, `member_joined_channel`, and `member_left_channel`. Then install
the app to your workspace and copy the bot and app tokens into the runtime's
environment (the `.env` file for a native install, `-e` flags for Docker). See
**[Configuration](configuration.md)**.

> Exact scope requirements can shift with Slack's API; the list above reflects
> the events and API calls the agent makes. Grant a scope when Slack tells you a
> call was denied for lack of it.

## Linking your identity

Before the agent will talk to you, it needs to know who you are. Linking is
started from the **[Web UI → Channels](web-ui.md#channels-slack)** page, which
issues a short-lived six-character code.

### Personal Mode — DM the agent

1. In the Web UI, open **Channels** and click **Link Account** under Personal
   Mode. You get a six-character code (e.g. `A1B2C3`), valid for about 15
   minutes.
2. Open a DM with the agent in Slack and send it the code. (Slack formatting is
   tolerated — `*A1B2C3*` works too.)
3. The agent confirms the link. From then on you can chat with it in that DM.

If an unrecognized person DMs the agent, it replies with a short prompt
explaining how to link, rather than answering.

### Team Mode — link channels

1. In the Web UI **Channels** page, click **Add channel** to generate a
   **channel link code**.
2. Invite the agent to the Slack channel.
3. Post the code in the channel. The agent confirms it's now connected.

You can link **multiple channels** to the agent — click **Add channel** again
for each one; linked channels appear in a table on the Channels page, each with
an **Unlink** action. A channel can only be linked to one agent.

#### The main channel

When several channels are linked, one is the **main channel** (marked ★ in the
table; the first channel you link becomes main by default). It controls where
the agent's *autonomous* messages go:

- **Heartbeat alerts** post to the main channel only — never fanned out to every
  linked channel.
- **Scheduled tasks** post to the channel they were created in; if that channel
  can't be resolved (e.g. it was unlinked), they fall back to the main channel.

Replies to your own messages always go back to the channel you wrote in,
regardless of which channel is main. Use **Set main** in the table to move it.

Personal Mode and Team Mode are mutually exclusive — unlink all channels before
switching to a DM link, and vice-versa.

## How the agent behaves in Slack

- **DMs.** It treats your DM as a conversation thread and replies to everything
  you send.
- **Channels.** It responds when **@mentioned** and when you reply within a
  thread it's already part of. Other channel messages are observed for context
  but not answered. When a thread it participated in gets a new message, a quick
  classifier decides whether to **reply**, **react** (e.g. 👀, 👍), or stay
  quiet — so it doesn't talk over the channel. The agent knows **which channel**
  it's replying in (the channel name is part of its context), so it can behave
  differently across linked channels.
- **Threads.** Each Slack thread maps to a Prism conversation thread; the agent
  can read the thread's history, including messages from before it joined.
- **Files.** You can share files with the agent in Slack, and it can share files
  back (uploaded via the Slack API). If a file can't be read (too large, or a
  permissions issue), the agent tells you why.
- **Feedback.** Final messages carry 👍 / 👎 buttons; tapping one records
  feedback.

Autonomous messages from the agent — [heartbeat](heartbeat.md) alerts and
[scheduled task](scheduled-tasks.md) results — arrive as channel posts. In Team
Mode they route by the [main-channel](#the-main-channel) rules above (heartbeats
to the main channel; scheduled tasks to their origin channel, falling back to
the main channel); in Personal Mode they arrive in your DM.

## Slack-triggered heartbeats

You can designate a Slack channel as a **heartbeat trigger** (from the Web UI
Channels page). When a message lands in that channel, it wakes the agent's
heartbeat with those messages as context — letting the agent react to real-time
channel activity between its scheduled runs. A per-channel **throttle** caps how
often this can fire, and pending messages are queued and drained so none are
lost even if several arrive while the agent is busy. See
**[Heartbeat → Slack-triggered heartbeats](heartbeat.md#slack-triggered-heartbeats)**.
