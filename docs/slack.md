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

### Team Mode — link a channel

1. In the Web UI **Channels** page, generate a **channel link code**.
2. Invite the agent to the Slack channel.
3. Post the code in the channel. The agent confirms it's now connected.

When the agent is first added to a channel it posts a brief hello explaining it
needs a verification code to activate. Each channel can be linked to one agent.

## How the agent behaves in Slack

- **DMs.** It treats your DM as a conversation thread and replies to everything
  you send.
- **Channels.** It responds when **@mentioned** and when you reply within a
  thread it's already part of. Other channel messages are observed for context
  but not answered. When a thread it participated in gets a new message, a quick
  classifier decides whether to **reply**, **react** (e.g. 👀, 👍), or stay
  quiet — so it doesn't talk over the channel.
- **Threads.** Each Slack thread maps to a Prism conversation thread; the agent
  can read the thread's history, including messages from before it joined.
- **Formatting.** Replies use Slack's native markdown (mrkdwn): bold, italics,
  lists, code blocks, links, and so on. Long replies are split across Block Kit
  blocks. Tables are flattened to bullet lists (Slack has no table support).
- **Files.** You can share files with the agent in Slack, and it can share files
  back (uploaded via the Slack API). If a file can't be read (too large, or a
  permissions issue), the agent tells you why.
- **Mentions.** When you mention other people, the agent sees their names; when
  it mentions someone back, Slack notifies them as usual.
- **Feedback.** Final messages carry 👍 / 👎 buttons; tapping one records
  feedback and briefly shows a thank-you.

Autonomous messages from the agent — [heartbeat](heartbeat.md) alerts and
[scheduled task](scheduled-tasks.md) results — arrive as channel posts labeled
with their source.

## Slack-triggered heartbeats

You can designate a Slack channel as a **heartbeat trigger** (from the Web UI
Channels page). When a message lands in that channel, it wakes the agent's
heartbeat with those messages as context — letting the agent react to real-time
channel activity between its scheduled runs. A per-channel **throttle** caps how
often this can fire, and pending messages are queued and drained so none are
lost even if several arrive while the agent is busy. See
**[Heartbeat → Slack-triggered heartbeats](heartbeat.md#slack-triggered-heartbeats)**.
