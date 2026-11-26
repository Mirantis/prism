# Slack

Prism Agent can run in Slack — responding to direct messages and channel mentions,
holding threaded conversations, and waking on activity in designated channels.
A Slack app of your own runs over **Socket Mode**, so no public webhook or inbound
URL is needed. An agent can also run on a [shared Slack app](#a-shared-slack-app).

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
mentions, uploading/reading files, reading user and channel info, adding
reactions, and showing its working status. A working set of bot scopes:

```
app_mentions:read   chat:write        im:history        im:read
channels:history    groups:history    files:read        files:write
users:read          reactions:write   assistant:write   conversations.connections:write
channels:read       groups:read
```

`channels:read` and `groups:read` let the agent check that a person it mentions
in a [sent message](tools.md#sending-messages) is in the channel.

`assistant:write` powers the "is thinking…" status line while the agent works
(see below); rendering it also requires the Slack app's **Agents & AI Apps**
feature to be enabled.

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
started from the **[Web UI → Channels](web-ui.md#channels)** page, which
issues a short-lived six-character code. On a
[shared Slack app](#a-shared-slack-app) you link your account and channels where
the agent was added to Slack instead, and the agent ignores link codes.

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
3. **@mention the agent** in the channel with the code. The agent confirms it's
   now connected.

You can link **multiple channels** to the agent — click **Add channel** again
for each one; linked channels appear in a table on the Channels page, each with
an **Unlink** action. A channel can only be linked to one agent.

#### The main channel

When several channels are linked, one is the **main channel** (marked ★ in the
table; the first channel you link becomes main by default). **Heartbeat alerts**
post to the main channel only — never fanned out to every linked channel. Use
**Set main** in the table to move it.

The main channel applies to heartbeats only. **Scheduled tasks** post to the
channel they were created in; if that channel can't be resolved (e.g. it was
unlinked) the run is logged as undeliverable rather than rerouted elsewhere.
**Replies** to your own messages always go back to the channel you wrote in.

Personal Mode and Team Mode are mutually exclusive — unlink all channels before
switching to a DM link, and vice-versa.

## How the agent behaves in Slack

- **DMs.** It treats your DM as a conversation thread and replies to everything
  you send. Your DM history stays in Slack — it's kept separate from the web
  chat, so DM messages don't show up there. You can also reply **in a thread**
  on one of the agent's DM messages; the agent keeps that thread's context and
  replies back inside the same thread.
- **Channels.** It responds when **@mentioned** and when you reply within a
  thread it's already part of. When a thread it participated in gets a new
  message, a quick classifier decides whether the message gives the agent
  something to do, a reply or work, or whether it stays quiet, so it doesn't
  talk over the channel. The agent knows **which channel** it's replying in (the
  channel name is part of its context), so it can behave differently across
  linked channels.
- **Threads.** Each Slack thread maps to a conversation thread in
  Prism Agent; the agent can read the thread's history, including messages
  from before it joined.
- **Working cue.** While the agent works on your message it shows a live
  status in the reply thread: "is thinking…" while the model reasons, and the
  running tools while any are in flight — "is running kubectl…", or "is
  running kubectl and pwd…" when the agent runs tools in parallel. When the
  status is not available (for example a top-level DM), it reacts to your
  message with 👀 instead. The cue disappears when the reply lands, or on
  error. Heartbeats and scheduled runs never show it.
- **Messages sent mid-reply.** Long tasks post progress as they go, and you can
  post while one is running. A message that lands mid-task is handed to the work
  already in flight: the agent picks it up at its next step and adjusts, so
  "no need to run tests" takes effect during the run instead of after it.
  Whatever arrives too late for that turn is answered together in one follow-up
  message rather than one reply per message.
- **Files.** You can share files with the agent in Slack, and it can share files
  back (uploaded via the Slack API). In a thread, the agent reads the files on
  every message, also on a message that did not mention it. Each turn stores up
  to 10 such files, so a thread with more has them all after a few turns. If a
  file can't be read (too large, or a permissions issue), the agent tells you why. Shared file
  content is kept for 7 days (see [Tools](tools.md#attachments)); after that the
  agent still sees that the file existed but must ask you to share it again to
  read it.
- **Feedback.** Final messages carry 👍 / 👎 buttons; tapping one records
  feedback.
- **Tables, charts and buttons.** The agent can post them as a message of their
  own. Anyone in the conversation can press a button once: the message then
  names the choice and who made it, and the agent answers it as that person's
  reply.

Autonomous messages from the agent — [heartbeat](heartbeat.md) alerts and
[scheduled task](scheduled-tasks.md) results — arrive as channel posts. In Team
Mode, heartbeat alerts go to the [main channel](#the-main-channel) and scheduled
tasks go to the channel they were created in; in Personal Mode they arrive in
your DM.

## A shared Slack app

An agent can run on a Slack app that many agents share. The platform that hosts
the agent sets it up, so there is no Slack app to create:

| Variable | Value |
|----------|-------|
| `SLACK_API_URL` | The shared app's Slack API proxy. Every Slack call of the agent goes there. |
| `SLACK_BOT_TOKEN` | The agent's token for that proxy. |
| `SLACK_PORT` | *(optional)* The port the shared app's router delivers the agent's Slack messages to. Default `3980`. |

Leave `SLACK_APP_TOKEN` unset. Slack stays off until the agent is added to a
Slack workspace, and turns on without a restart when it is. When you bring the
agent into a thread that already has messages, it reads them once.

To run the shared app yourself, see [Slack router protocol](slack-router-protocol.md).

## Slack-triggered heartbeats

You can designate a Slack channel as a **heartbeat trigger** (from the Web UI
Channels page). When a message lands in that channel, it wakes the agent's
heartbeat with those messages as context — letting the agent react to real-time
channel activity between its scheduled runs. Link the channel before you make
it a heartbeat trigger. A per-channel **throttle** caps how often this can
fire, and pending messages are queued and drained so none are lost even if
several arrive while the agent is busy. See
**[Heartbeat → Slack-triggered heartbeats](heartbeat.md#slack-triggered-heartbeats)**.
