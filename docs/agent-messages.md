# Agent messages

When a delivery service carries messages between the agents of a project, the
other agents can send the agent messages, and it sends them messages with the
`message_agent` tool. A message from another agent arrives in the agent's web
conversation and starts a turn, like one of yours. The agent treats it as a
colleague's request, never as your words or your approval.

The platform the agent runs on sets it up: it gives the runtime the delivery
service's API token id in `AGENT_MESSAGES_TOKEN_ID`, and the agent knows who the
other agents are when its MCP endpoint (`NEXUS_MCP_URL`) has a `list_agents`
tool.

## What you see

- **In the conversation**, a message from another agent shows on the other
  side, as another participant's, under "{name} · Agent". A notice from the
  delivery service about the agent's own messages, such as one that could not
  be delivered or an answer that did not come, shows under its sender's name
  alone.
- **The agent's answer** appears in the conversation like any reply. It answers
  the other agent with `message_agent` when that agent waits for an answer.

## Who the other agents are

The runtime adds nothing about the other agents to a conversation. The
messaging tools tell the agent: `list_agents`' description says that other
agents very likely exist, names them with their roles, and says to call
`list_agents` before a task, and `message_agent`'s says how to treat a message
from another agent. The tools are in every run, so a heartbeat check, a
scheduled task, a goal or a webhook run knows the other agents as much as a
chat does.

The `colleagues.` prompt evals check that the agent hands a task that matches
another agent's role to that agent, keeps its own work, and calls nothing for
a thank-you or a general question.

## Delivering a message: `POST /agents/agent-messages`

The delivery service posts each message to the runtime port through the
ingress. The ingress admits more than the delivery service, such as the people
of the project, their API tokens and the other agents themselves. It names the
API token each caller used in `x-forwarded-token-id`, and drops any copy the
caller sent, so the runtime takes a delivery on the ingress's word:

- A request the ingress names a person for (`x-forwarded-user` or
  `x-forwarded-user-id`) is refused with `403`.
- Otherwise `x-forwarded-token-id` must be `AGENT_MESSAGES_TOKEN_ID`, the id of
  the delivery service's API token, compared in constant time. Any other caller,
  or one with no token id, gets `401`. Until `AGENT_MESSAGES_TOKEN_ID` is set,
  every delivery gets `503`, so the service sends it again once it is.

The header is trustworthy only for a request that came through the ingress. A
caller that reaches the runtime port some other way can write it, so the runtime
listens on loopback (`PRISM_HOST=127.0.0.1`, the default outside the Docker
image) where the platform tunnels to it.

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

The message goes to the web conversation that holds its `conversationId`:
the one where the agent's own `message_agent` call started or answered that
conversation, or where an earlier message of it arrived. A reply, and a notice
about a message, carry the conversation of the message they are about. A
conversation the runtime has not seen yet, or one whose web conversation was
deleted or is hidden by single-thread mode, goes to the one conversation when
`THREAD_MODE=single`, otherwise to the newest one.

| Status | Meaning |
|--------|---------|
| `202` `{"messageId","threadId","queued","duplicate"}` | Stored, and its turn is scheduled. `duplicate: true` means the same `id` was already stored. |
| `400` `{"error"}` | The body does not match the contract. |
| `401` `{"error"}` | The ingress names no API token, or another one than `AGENT_MESSAGES_TOKEN_ID`. |
| `403` `{"error"}` | The ingress names a person. |
| `409` | The `id` belongs to another message: a person's, or another sender's or message id's. |
| `503` `{"error"}` | The agent is still starting, or `AGENT_MESSAGES_TOKEN_ID` is not set. Send it again later. |

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

- **The agent does not know the other agents.** It needs the `list_agents`
  tool on its MCP endpoint, which the platform the agent runs on grants. The
  agents its description names are as the platform last stored them.
- **A delivery answers `503`.** The agent is still starting, or
  `AGENT_MESSAGES_TOKEN_ID` is not set in its environment. The delivery service
  sends the message again. The log has a warning that starts with
  `[AgentMessages]`.
- **A delivery answers `401`.** The ingress named no API token, or another one
  than `AGENT_MESSAGES_TOKEN_ID`: the variable holds the wrong id, or the request
  did not come from the delivery service. The log line names the reason and the
  start of the token id it got.
