# Agent messages

The agent can receive messages from other agents. A delivery service carries
each message to the agent, and the message arrives in the agent's web
conversation and starts a turn, like one of yours. The agent treats it as a
colleague's request, never as your words or your approval.

The platform that hosts the agent sets this up. It gives the runtime the
delivery service's API token id in `AGENT_MESSAGES_TOKEN_ID`. It also provides
the tools the agent uses to find the other agents and to send them messages.

## What you see

- **In the conversation**, a message from another agent shows on the other
  side, as another participant's, under "{name} · Agent". A notice from the
  delivery service about the agent's own messages, such as one that could not
  be delivered or an answer that did not come, shows under its sender's name
  alone.
- **The agent's answer** appears in the conversation like any reply. When the
  other agent waits for an answer, the agent sends it with the platform's
  messaging tool.

## Delivering a message: `POST /agents/agent-messages`

The delivery service posts each message through the ingress to a port of
its own, `AGENT_MESSAGES_PORT` (`3005` by default), which serves this route
alone. The runtime's main port (`PORT`) does not serve it, so a deployment
routes deliveries apart from the API, and the listener has no browser access:
no CORS, no Web UI. It listens on the same interface as the API (`PRISM_HOST`).
`GET /agents/state` stays on the main port.

The port is opened only when `AGENT_MESSAGES_TOKEN_ID` is set: without it no
delivery could be accepted, so the runtime does not listen at all. The variable
is read at startup, so setting it takes a restart.

The ingress admits more than the delivery service, such as the people
of the project, their API tokens and the other agents themselves. It names the
API token each caller used in `x-forwarded-token-id`, and drops any copy the
caller sent, so the runtime takes a delivery on the ingress's word:

- A request the ingress names a person for (`x-forwarded-user` or
  `x-forwarded-user-id`) is refused with `403`.
- Otherwise `x-forwarded-token-id` must be `AGENT_MESSAGES_TOKEN_ID`, the id of
  the delivery service's API token, compared in constant time. Any other caller,
  or one with no token id, gets `401`.

The header is trustworthy only for a request that came through the ingress:
a caller that reaches the port some other way can write it.

People talk to the agent in the conversation. This route is the only one that
stores an agent's message: `POST /agents/threads/:threadId/messages` refuses
`triggeredBy: "AGENT_MESSAGE"` with `400`.

```json
{
  "id": "<uuid v4: the delivery id>",
  "messageId": "<uuid: the message's id, which a reply names>",
  "conversationId": "<uuid>",
  "kind": "message",
  "sender": { "id": "<agent id>", "name": "Researcher" },
  "content": "Can you check whether CI is green on main?",
  "expectsReply": true,
  "attachmentIds": []
}
```

| Field | Rule |
|-------|------|
| `id` | A uuid v4. It becomes the stored message's id, so the same `id` is stored once. |
| `kind` | `message`, or `notice` for what the delivery service itself tells the agent. |
| `sender` | `id` at most 64 characters, `name` at most 128, each kept to one line. A notice's sender is the delivery service itself. |
| `content` | 1 to 32,000 characters, not blank. |
| `expectsReply` | Optional, `false` by default. |
| `attachmentIds` | Optional, at most 5. Upload each file first with `POST /agents/attachments`. |

The message goes to the web conversation where an earlier message of its
`conversationId` arrived. A reply, and a notice about a message, carry the
conversation of the message they are about. A conversation the runtime has
not seen yet goes to the one conversation when `THREAD_MODE=single`,
otherwise to the newest one, and so does one whose web conversation was
deleted or is hidden by single-thread mode. The runtime does not read what
the agent sends to other agents, so an answer to the agent's own message is a
conversation it has not seen: with several conversations, it arrives in the
newest one, which may not be the one the agent asked from.

| Status | Meaning |
|--------|---------|
| `202` `{"messageId","threadId","queued","duplicate"}` | Stored, and its turn is scheduled. `duplicate: true` means the same `id` was already stored. |
| `400` `{"error"}` | The body does not match the contract. |
| `401` `{"error"}` | The ingress names no API token, or another one than `AGENT_MESSAGES_TOKEN_ID`. |
| `403` `{"error"}` | The ingress names a person. |
| `409` | The `id` belongs to another message: a person's, or another sender's or message id's. |
| `503` `{"error"}` | The agent is still starting. Send it again later. |

On the [chat socket](websocket-protocol.md), the message is a `USER` message with
`triggeredBy: "AGENT_MESSAGE"`, the sender's `senderId` and `senderName`, and
`agentMessageKind`: `message`, `ask` for one that waits for an answer, or
`notice`.

## Running an older image

The runtime stores another agent's message with `triggeredBy:
AGENT_MESSAGE`, which needs no migration. An image from before agent messages
does not know that value: once such a message is stored, it fails to read the
conversation that holds it, and the web conversation stops loading. Don't pin
an older image after the agent has received a message from another agent.

## The agent's state: `GET /agents/state`

Answers `{"state": "working"}` while a turn runs or waits, or other work is in
flight, such as a scheduled task or a coding task. Otherwise it answers
`{"state": "idle"}`.

## When something goes wrong

- **The agent does not know the other agents.** The platform that hosts the
  agent provides the tools to find them. Check that the platform gives the agent
  those tools.
- **A delivery gets no answer, or the platform's own error.** One of these:
  - `AGENT_MESSAGES_TOKEN_ID` is not set, so the port is not open. The log
    says `[AgentMessages] AGENT_MESSAGES_TOKEN_ID is not set` at startup. Set
    it and restart.
  - The agent-messages port is not exposed.
  - Another process holds the port. The log has an error that starts with
    `[AgentMessages] Cannot listen`. Choose a free `AGENT_MESSAGES_PORT` and
    restart.
- **A delivery answers `503`.** The agent is still starting. The delivery
  service sends the message again. The log has a warning that starts with
  `[AgentMessages]`.
- **A delivery answers `401`.** The ingress named no API token, or another one
  than `AGENT_MESSAGES_TOKEN_ID`: the variable holds the wrong id, or the request
  did not come from the delivery service. The log line names the reason and the
  start of the token id it got.
