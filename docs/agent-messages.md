# Agent messages

When the agent runs on Lens Agents with Irene Agent, the other agents of its
project can send it messages, and it sends them messages with the
`message_agent` tool. A message from another agent arrives in the agent's web
conversation and starts a turn, like one of yours. The agent treats it as a
colleague's request, never as your words or your approval.

There is nothing to turn on. The agent takes messages from the other agents
whenever Irene Agent delivers them, and it knows who they are when its Lens
Agents tools include `list_agents`.

## What you see

- **In the conversation**, a message from another agent shows on the other
  side, as another participant's, under "{name} · Agent". A notice from Irene
  Agent about the agent's own messages, such as one that could not be delivered
  or an answer that did not come, shows under "Irene Agent".
- **The agent's answer** appears in the conversation like any reply. It answers
  the other agent with `message_agent` when that agent waits for an answer.

## Who the other agents are

Before the agent answers in a conversation, it reads which other agents are in
the project and what each one does. The first time in a conversation, and after
[compaction](compaction.md), the conversation gets the whole list; after that it
gets only what changed. The list stays hidden from clients. A conversation is
where the agent reads it: in a heartbeat check, a scheduled task, a goal or a
webhook run, the agent calls `list_agents` itself.

## Delivering a message: `POST /agents/agent-messages`

Irene Agent posts each message to the runtime port, through the Lens Agents
private ingress. The ingress admits every member of the project: a person, a
person's API token, another agent's own token, and Irene Agent's session. So
Irene Agent signs each delivery, and the runtime takes none without that
signature (`lib/agent-message-signature.ts`):

- `x-agent-message-signature` holds an ES256 compact JWT with `typ`
  `agent-message+jwt`. It names this agent in `aud` and the SHA-256 of the
  exact body in `sha256` (base64url), and is good for a minute.
- The public keys and the agent's own id come from `list_agents`, in the
  `delivery` field of its answer, which the runtime asks for itself through the
  Lens Agents MCP. The runtime keeps them in `runtime_state`
  (`agentMessageKeys`) and trusts them for an hour. A signature with a key it
  does not hold makes it ask again, at most every 30 seconds, so a new key
  reaches it with the next delivery.

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
| `kind` | `message`, or `notice` for what Irene Agent itself tells the agent. |
| `sender` | `id` at most 64 characters, `name` at most 128, each kept to one line. A notice comes from `irene-agent`, and nothing else does. |
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
| `401` `{"error"}` | No signature, or one that is not Irene Agent's, or not for this agent and this body. |
| `409` | The `id` belongs to another message: a person's, or another sender's or message id's. |
| `503` | The agent is still starting, or cannot read the keys right now. Send it again later. |

On the [chat socket](websocket-protocol.md), the message is a `USER` message with
`triggeredBy: "AGENT_MESSAGE"` and the sending agent's `senderId` and
`senderName`.

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
  tool: a project administrator opens the agent in an Irene Agent client, which
  grants it. When the agent cannot read the list, the log has a warning that
  starts with `[AgentRoster]`, and the turn runs without it.
- **A delivery answers `503`.** The agent is still starting, or cannot read
  the keys from `list_agents`. Irene Agent sends the message again. The log
  has a warning that starts with `[AgentMessages]`.
- **A delivery answers `401`.** It came without Irene Agent's signature, or
  with a key `list_agents` does not list. The log line names the reason.
