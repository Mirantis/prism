# Slack router protocol

This page is for people who run a shared Slack app for many agents. It describes
what a router sends to an agent, and what the Slack API proxy has to answer. An
agent set up as in [A shared Slack app](slack.md#a-shared-slack-app) uses this
protocol.

The schema in `src/services/slack-router-envelope.ts` is the authority.

## Parts

You run three parts in front of the agents:

- **The router** takes the shared app's events from Slack, finds the agent each
  one is for, and posts it to that agent as an envelope.
- **An ingress** in front of each agent's `SLACK_PORT` checks that a request
  comes from your router.
- **The Slack API proxy**, at `SLACK_API_URL`, takes the agent's Slack calls,
  checks each one, and makes it with the workspace's bot token.

The agent holds no Slack token and does not reach Slack. Its `SLACK_BOT_TOKEN`
is a token for your proxy.

## The ingress

The agent accepts a request only when it has `x-nexus-webhook-verified: 1`.
Your ingress must:

1. Check the router's signature on the raw body, and refuse the request when it
   fails.
2. Remove any `x-nexus-webhook-verified` header the caller sent.
3. Add `x-nexus-webhook-verified: 1`, then forward the request.

Do not publish `SLACK_PORT` without such an ingress. Anyone who can reach the
port could otherwise speak for Slack. A Lens Agents `webhook` port does all
three steps.

## Delivering an envelope

```http
POST /agents/slack/router
Content-Type: application/json
x-nexus-webhook-verified: 1

{"version":1,"kind":"slack", …}
```

The body is at most 1 MiB. The agent answers:

| Status | Body `error` | What to do |
|--------|--------------|------------|
| `200` | | Done. The agent accepted it, or had accepted it before. |
| `400` | `invalid_envelope` | Do not send it again. |
| `401` | `not_verified` | The ingress did not mark the request. Fix the ingress. |
| `413` | `too_large` | Do not send it again. |
| `500`, `503` | `internal_error`, `unavailable` | Send it again later. |

Send the envelopes of one Slack thread one at a time, in the order the events
happened.

Every envelope has these fields:

| Field | Value |
|-------|-------|
| `version` | `1` |
| `kind` | `slack`, `link`, `connected` or `disconnected` |
| `eventId` | Unique per event. Keep it the same when you send the event again. |
| `sentAt` | The time of this attempt, ISO 8601 with an offset. Set it again on each attempt. |
| `teamId` | The Slack workspace. |

The agent drops, with `200`, an envelope whose `sentAt` is more than 5 minutes
from its clock, and one whose `eventId` it accepted in the last 15 minutes. An
unknown field, kind or version is a `400`.

## `connected` and `disconnected`

Send `connected` when the agent is added to a Slack workspace, after its proxy
token answers `auth.test` for that workspace:

```json
{"version":1,"kind":"connected","eventId":"…","sentAt":"…","teamId":"T0123",
 "workspace":{"teamId":"T0123","teamName":"Example","botUserId":"U0BOT","botId":"B0BOT"}}
```

The agent starts its Slack connection, with no restart. Until then it answers
`503` to a `slack` envelope, so send that envelope again later.

Send `disconnected` when the agent is removed. The agent stops its connection
and keeps its links. Send a `link` with `"op":"remove"` for each one first.

## `link`

A link says where the agent may post on its own, for example the result of a
scheduled task. Send one when a person links or unlinks a DM or a channel:

```json
{"version":1,"kind":"link","eventId":"…","sentAt":"…","teamId":"T0123",
 "link":{"op":"add","type":"dm","slackUserId":"U0ALICE","dmChannelId":"D0ALICE","personId":"alice"}}
```

```json
{"link":{"op":"add","type":"channel","channelId":"C0OPS","personId":"alice"}}
```

`personId` is your id for the person who made the link. Adding a link that
exists, or removing one that does not, is a `200`.

Send the `link` envelopes of one DM or channel one at a time, in order, and do
not send one again after a later one for the same DM or channel was accepted.
The agent remembers accepted event ids in memory only, so after a restart an
older `add` sent again would undo a later `remove`.

## `slack`

A Slack event or a button press, for this agent:

```json
{"version":1,"kind":"slack","eventId":"Ev0123","sentAt":"…","teamId":"T0123",
 "route":"mention","person":{"id":"alice"},"payloadType":"event",
 "payload":{"type":"message","channel":"C0OPS","channel_type":"channel",
            "user":"U0ALICE","text":"<@U0BOT> is the deploy done?","ts":"1767225600.000100"}}
```

`route` is your routing decision:

| `route` | Meaning | `payloadType` |
|---------|---------|---------------|
| `dm` | A direct message for this agent. | `event` |
| `mention` | A message that addresses this agent: a mention, its user group, or its name. | `event` |
| `thread_reply` | A reply without a mention, in a thread this agent takes part in. The agent decides whether it answers. | `event` |
| `channel_event` | `member_joined_channel` or `member_left_channel`. | `event` |
| `action` | A press of a button the agent posted. | `block_actions` |

Send one envelope per Slack message. A post that mentions the app reaches you
twice, as a `message` event and as an `app_mention` event with different event
ids; deliver only one of them, or the agent answers twice.

`person` is the person who sent it, or `null` when they have no account with
you. `payload` is in Slack's own shape. The agent reads these fields:

- `message` and `app_mention`: `type`, `subtype`, `channel`, `channel_type`,
  `user`, `bot_id`, `text`, `ts`, `thread_ts`, and `files` with `id`, `name`,
  `mimetype`, `size`, `url_private` and `url_private_download`.
- `member_joined_channel` and `member_left_channel`: `type`, `user`, `channel`.
- `block_actions`: `user.id`, `channel.id`, `message.ts`, `message.text`,
  `message.blocks`, and `actions` with `action_id`, `block_id` and `value`.

Put a file's URLs on your proxy's origin. The agent sends its token only there,
and does not fetch a file whose URL is on Slack's own hosts.

Send only messages from people. The agent stores what it posts, so it needs no
copy of its own messages.

## The Slack API proxy

The agent calls `POST <SLACK_API_URL><method>` the way it calls Slack, with
`Authorization: Bearer <SLACK_BOT_TOKEN>`, and form or JSON bodies as
`@slack/web-api` sends them. Answer in Slack's shape: `{"ok":true,…}`, or
`{"ok":false,"error":"…"}`. Answer `429` with `Retry-After` to slow the agent
down.

| Method | Parameters the agent sends | Fields the agent reads |
|--------|---------------------------|------------------------|
| `auth.test` | none | `team_id`, `team`, `user_id`, `bot_id` |
| `bots.info` | `bot` | `bot.app_id` |
| `chat.postMessage` | `channel`, `text`, `blocks`, `thread_ts`, `metadata` | `ts` |
| `chat.update` | `channel`, `ts`, `blocks` | |
| `reactions.add`, `reactions.remove` | `channel`, `timestamp`, `name` | |
| `assistant.threads.setStatus` | `channel_id`, `thread_ts`, `status` | |
| `conversations.replies` | `channel`, `ts`, `limit` | `messages` with `ts`, `user`, `bot_id`, `username`, `text` |
| `conversations.info` | `channel` | `channel.name` |
| `conversations.members` | `channel`, `limit`, `cursor` | `members`, `response_metadata.next_cursor` |
| `users.info` | `user` | `user.real_name`, `user.name` |
| `files.getUploadURLExternal` | `filename`, `length` | `upload_url`, `file_id` |
| `files.completeUploadExternal` | `files`, `channel_id`, `thread_ts` | |

The agent then posts the file's bytes to `upload_url` with the same
`Authorization` header.

The agent posts with no name or icon of its own. When several agents share
one app, set `username` and `icon_url` on each post so people can tell the
agents apart. `auth.test` answers `invalid_auth` until the agent is added to a
workspace.
