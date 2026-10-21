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
private ingress, which authenticates the call. A request that the ingress
names a person for (`x-forwarded-user-id`) is refused with `403`: people talk
to the agent in the conversation.

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
| `sender` | `id` at most 64 characters, `name` at most 128. |
| `content` | 1 to 32,000 characters, not blank. |
| `expectsReply` | Optional, `false` by default. |
| `attachmentIds` | Optional, at most 5. Upload each file first with `POST /agents/attachments`. |

The message goes to the web conversation: the one conversation when
`THREAD_MODE=single`, otherwise the newest one.

| Status | Meaning |
|--------|---------|
| `202` `{"messageId","threadId","queued","duplicate"}` | Stored, and its turn is scheduled. `duplicate: true` means the same `id` was already stored. |
| `400` `{"error"}` | The body does not match the contract. |
| `403` | A person sent it. |
| `409` | The `id` belongs to another message. |
| `503` | The agent is still starting. Send it again later. |

On the [chat socket](websocket-protocol.md), the message is a `USER` message with
`triggeredBy: "AGENT_MESSAGE"` and the sending agent's `senderId` and
`senderName`.

## The agent's state: `GET /agents/state`

Answers `{"state": "working"}` while a turn runs or waits, or other work is in
flight, such as a scheduled task or a coding task. Otherwise it answers
`{"state": "idle"}`.

## When something goes wrong

- **The agent does not know the other agents.** It needs the `list_agents`
  tool: a project administrator opens the agent in an Irene Agent client, which
  grants it. When the agent cannot read the list, the log has a warning that
  starts with `[AgentRoster]`, and the turn runs without it.
- **A delivery answers `503`.** The agent is still starting. Irene Agent sends
  the message again.
