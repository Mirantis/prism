# Chat socket protocol

This page is for people writing a client for Prism's chat. It describes version
2 of the chat socket, `/api/ws`, which the web UI and the terminal UI speak too.

The schemas in `backend/src/protocol/chat_protocol.rs` are the authority. The frames in
`backend/src/protocol/fixtures/` are real examples.

## What the protocol promises

- Every client of an agent sees the same conversations, in the same order,
  including the messages other people and other devices send.
- A client that loses its connection gets back everything it missed. If the
  runtime can no longer replay the gap, it says so, and the client reloads
  history. A client is never silently out of date.
- A message is confirmed only once it is stored. A confirmed message is answered.
  When the runtime restarts first, it answers the message after the restart.
- Sending a message again with the same id never creates a second copy. A client
  can therefore always retry a message that was not confirmed.

## Frames

Every frame is a JSON text frame, except voice and dictation audio, which are
binary frames. A frame is at most 1 MB.

| Direction | Shape | Used for |
|---|---|---|
| client → server | `{ type, id, payload }` | requests; `id` is yours, up to 64 characters |
| server → client | `{ type, seq, payload }` | stream events, numbered |
| server → client | `{ type: "ack" \| "nack", re, payload }` | the answer to your request `re` |
| server → client | `{ type, payload }` | frames for your socket only: `welcome`, voice, dictation |

## Connecting

1. Open the socket.
2. Send `hello` as the first frame, within 5 seconds:

   ```json
   {"type":"hello","id":"h1","payload":{"protocol":2,"client":{"name":"my-client","version":"1.0"},"resume":{"streamId":"…","seq":41}}}
   ```

   Leave out `resume` on a first connection.

3. The server answers `welcome`:

   ```json
   {"type":"welcome","payload":{"protocol":2,"streamId":"…","seq":57,"resumed":true,"you":{"id":"ada@example.com","name":"ada@example.com"},"threadMode":"multi","snapshot":{"turns":[{"threadId":"…","state":"running","step":{"index":14,"tool":"web_search"}}],"computer":{},"questionCards":[{"id":"…","threadId":"…"}]}}}
   ```

   - `streamId` and `seq` together are your cursor. Keep the `seq` of the last
     event you applied.
   - If `resumed` is `true`, the frames that follow `welcome` are every event
     after your cursor, in order, and then live events.
   - If `resumed` is `false`, reload history for the conversation on screen with
     `GET /messages?threadId=…`. Keep any events that arrive while that request
     is running, and apply them afterwards.
   - `threadMode` is `single` when the agent keeps one conversation. Then show no
     way to start or switch a conversation: `GET /threads` lists that one alone, and
     `POST /threads` returns it. A runtime that sends no `threadMode` keeps many.
   - `snapshot.turns` lists every conversation that is working (`running`) or
     waiting (`queued`). A conversation that is not listed is idle. A running
     conversation has `step` as in the `turn` event.
   - `snapshot.questionCards` lists every [question card](#question-cards) that
     waits for an answer, in every conversation a client can open, as
     `{ id, threadId }`, oldest first. A card that closes later arrives as a
     `message` event.
   - `you` is who the Mirantis Agent Platform sign-in says this connection is, or nulls when
     it did not say. Compare `you.id` with a message's `senderId` to tell your
     own messages from someone else's. Until the first `welcome`, draw every
     message as your own.

A client that sends anything else first, or names another protocol version, is
answered `nack` with the code `protocol_unsupported` and closed with code 4426.
Show the person that they need to update the app. A client that sends nothing
is closed with 4408 after 5 seconds, since a slow connection looks the same.

## Events

Each event has a `seq` that is exactly one more than the previous event's. If you
see a gap, reconnect and resume from the last `seq` you applied.

- **`message`**: one message, for any role: `USER`, `AGENT` or `SYSTEM`.
  - Upsert it by `id`. The same id arrives again when a message changes in place,
    for example when a help card is answered.
  - Your own messages arrive here too. That copy replaces the message you drew
    before it was confirmed.
  - Order a conversation by `createdAt`, then by `id`. `GET /messages` returns
    history in the same order: the newest `limit` messages (50 by default, at most
    200). Add `before=<message id>` for the page before that message. A page
    shorter than `limit` starts at the conversation's first message.
  - `senderId` and `senderName` say who wrote a `USER` message, or are `null`.
    Show `senderName`. Neither decides what anyone may do.
  - An attachment with `inline: true` is an image the text shows at its place,
    written `![description](attachment:<attachment id>)`. Draw it there from
    `GET /agents/attachments/<attachment id>`, and list only the other
    attachments under the message.
  - A `USER` message with `triggeredBy: "AGENT_MESSAGE"` is from another agent
    of the project, not from a person ([Agent messages](agent-messages.md)).
    Show it as another participant's, under "{senderName} · Agent", or under
    `senderName` alone for a notice. `agentMessageKind` is `message`, `ask` for
    one that waits for an answer, or `notice` for what the delivery service
    itself says; it is `null` on every other message:

    ```json
    {"type":"message","payload":{"id":"6f1c2a3b-4d5e-4f60-8a71-92b3c4d5e6f7","threadId":"…","role":"USER","content":"Can you check whether CI is green on main?","triggeredBy":"AGENT_MESSAGE","toolCalls":null,"blocks":null,"isCompacted":false,"createdAt":"2026-10-21T12:00:00.000Z","attachments":null,"senderId":"<agent id>","senderName":"Researcher","agentMessageKind":"ask"},"seq":12}
    ```

- **`turn`** `{ threadId, state, outcome?, error?, step? }`: what a conversation is doing.
  - `state` is `queued`, `running` or `idle`.
  - `step` `{ index, tool }` is the step a `running` turn is on. Each step that
    calls a tool arrives as another `running` event: `index` counts the turn's
    steps from 1, and `tool` names the tool the step called first. A turn that has
    called no tool yet has no `step`.
  - `step` arrives in concise mode too
    ([chat verbosity](configuration.md#chat-verbosity)), where the text of the
    turn's steps stays hidden.
  - `outcome` appears when a running conversation becomes idle: `completed`,
    `cancelled` or `failed`. A failure also has `error`, written for a person.
    A turn whose model call fails is `failed`, and its reply message describes
    the error.
  - A conversation's work ends only at `turn` `idle`. A `message` event does not
    end it: the agent can post several messages in one turn.
- **`thread`** `{ threadId, title, createdAt? }`: a conversation was created, or
  it got a new title. Add it to your list. `GET /threads` gives the list, newest
  first. Add `workspaceRoot=<folder>` for the conversations rooted in that folder.
- **`context`**, **`compaction`**, **`computer`**, **`update`**: how full a
  conversation's context is, compaction progress, the agent's computer, and
  runtime updates.
  - When `compaction` reports `completed`, reload the open conversation. Older
    messages have changed. `idle: true` marks a conversation compacted while it
    sat idle.
  - `computer` lists every computer the agent can use in `computers`, as
    `GET /agents/computers` does.

## Requests

Every request is answered `ack` or `nack`, with `re` set to its `id`.

### `send`

```json
{"type":"send","id":"r1","payload":{"message":{"id":"<uuid v4>","threadId":"…","content":"Hello","attachmentIds":[]}}}
```

- Make up a new uuid v4 for `message.id` and keep it until the message is
  confirmed. Draw the message straight away, under that id.
- `threadId` is required. Create a conversation with `POST /threads` first.
- Upload files first with `POST /agents/attachments`, and pass their ids here.
- `ack` `{ messageId, seq, queued, duplicate }` means the message is stored.
  `seq` is a stream position at or after the message's own `message` event.
  - `queued: true` means the message is waiting behind work in another
    conversation. Show that it is waiting.
  - `duplicate: true` means the message was already stored. Nothing new happened.
- If the socket drops before the `ack`, send the same frame again, with the
  same `message.id`, after the next `welcome`.
- A `nack` means the message was not stored. Stop resending it and let the person
  decide what to do. The one exception is `rate_limited`: wait `retryAfterMs`,
  then send it again.

| `nack` code | Meaning |
|---|---|
| `invalid` | The frame did not match the schema. `message` says what is wrong. |
| `unknown_thread` | There is no such conversation. |
| `id_conflict` | That message id belongs to an agent's message or another conversation. |
| `rate_limited` | Too many requests. Wait `retryAfterMs`. |
| `unavailable` | The agent is still starting. |
| `failed` | The message could not be stored. |

### `cancel`

`{"type":"cancel","id":"c1","payload":{"threadId":"…"}}` stops that
conversation's running turn, whichever client started it, and drops its queued
messages. Those messages stay in history, unanswered. Scheduled tasks, heartbeats
and goals that run in a conversation finish on their own.

### `ping`

`{"type":"ping","id":"p1"}` is answered `{"type":"pong","re":"p1"}`.

Send one every 25 seconds. If the `pong` has not arrived within 10 seconds,
treat the socket as dead and reconnect. A browser cannot see protocol-level
pings, and a phone can keep a socket that is dead without noticing.

### Voice and dictation

- `voice_start`, `voice_stop`, `dictation_start` and `dictation_stop` keep the
  payloads that [voice chat](voice-chat.md) and [dictation](dictation.md)
  describe, inside the envelope above.
- Their answers are `voice_*` and `dictation_*` frames for your socket only.
- Audio is binary frames, both ways.
- An agent has one voice call at a time.

## Question cards

An `AGENT` message can hold one block of type `question_card`. Its `content` is the
same questions as plain text, so a client that cannot draw the card shows `content`.

```json
{
  "type": "question_card",
  "id": "c9f1a2b3-4d5e-4f60-8a71-92b3c4d5e6f7",
  "status": "waiting",
  "intro": "A few decisions before I start.",
  "otherMaxLength": 500,
  "questions": [
    {
      "text": "How much can we spend each month?",
      "header": "Budget",
      "options": [
        { "label": "Under €500", "detail": "fits the current plan" },
        { "label": "€500 to €2,000" }
      ],
      "recommended": "Under €500",
      "allowOther": true,
      "multiSelect": false
    }
  ]
}
```

- `intro` is optional plain text. Show it above the first question. A closed card
  hides it with the questions and shows it again when the questions are opened.
- `header` is a short topic for `content` and the answer message. A card shows
  `text` alone.
- `status` is `waiting`, `answered` or `answered_in_chat`. A message a person types
  in the conversation closes a waiting card as `answered_in_chat`.
- An answered card also has `answers`, one per question in order, and `answeredBy`:
  `{ id, name }`, or `null` when the person is not known. Compare `answeredBy.id`
  with `you.id`.
- Each answer is `{ "options": [0], "other": "text" }`. `options` are indexes into
  the question's options. A blank question has `"options": []` and no `other`.
- A card that changes arrives again as a `message` event with the same message id.

Text limits count UTF-16 code units.

| Field | Limit |
|---|---|
| Questions per card | 1 to 7 |
| Options per question | 2 to 4 |
| `intro` | 300 |
| `text` | 300 |
| `header` | 40 |
| Option `label` | 80 |
| Option `detail` | 200 |
| `other` | 500 |

### `POST /agents/question-cards/:id/answer`

The body is `{ "answers": [ … ] }`, one answer per question, with at least one
question answered. The first answer wins, and its answers become one message from
the person who sent them.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ card }` | The answers were taken. |
| 202 | `{ card, replyPending: true }` | The answers are stored, and the agent's reply starts after the runtime next restarts. |
| 400 | `{ error }` | The answers do not fit the card. |
| 404 | `{ error }` | No such card in a conversation this client can see. |
| 409 | `{ error, card }` | The card is closed. `card` is the stored card, which the client shows. |
| 503 | `{ error }` | The agent is still starting. |

## Generated UI

An `AGENT` message can hold one block of type `generated_ui`: components the agent
chose to show, such as a table, a chart or buttons. The message's `content` is the
same UI as plain text, so a client that cannot draw the block shows `content`. The
JSON Schema of the block is
[`backend/src/protocol/fixtures/generated-ui.schema.json`](../backend/src/protocol/fixtures/generated-ui.schema.json). A message a real
runtime stored is
[`generated-ui-message.json`](../backend/src/protocol/fixtures/generated-ui-message.json)
beside it.

```json
{
  "type": "generated_ui",
  "version": 1,
  "id": "6b0d6a4e-2f1c-4d8e-9c55-1e2f3a4b5c6d",
  "root": "summary",
  "elements": {
    "summary": { "type": "Card", "props": { "title": "Deploys this week" }, "children": ["chart", "choose"] },
    "chart": {
      "type": "Chart",
      "props": {
        "kind": "bar",
        "title": "Deploys per day",
        "categories": ["Mon", "Tue", "Wed"],
        "series": [{ "name": "prod", "values": [3, 5, 2] }]
      }
    },
    "choose": { "type": "Actions", "children": ["roll-back", "keep"] },
    "roll-back": { "type": "Button", "props": { "label": "Roll back Wednesday", "style": "danger" } },
    "keep": { "type": "Button", "props": { "label": "Keep it" } }
  }
}
```

- `elements` maps an element id to `{ type, props, children }`. `props` and
  `children` are present only on the types that have them. `root` is the id of
  the element drawn first, and every other element is a child of exactly one
  element.
- Draw `children` in their order, inside their parent.
- The block is static. Draw it as it is: it holds no state, bindings or
  conditions, and no HTML or script.
- A pressed block also has `pressed`: `{ "elementId", "label", "by" }`, where `by`
  is `{ id, name }`, or `null` when the person is not known. Show which button was
  pressed and by whom, and take no more presses.
- A block that changes arrives again as a `message` event with the same message id.
- Ignore an element of a type you do not know. Show `content` instead of the
  block when its `version` is not `1`.

Element ids are 1 to 64 characters of `A-Z`, `a-z`, `0-9`, `_` and `-`. Text
limits count UTF-16 code units.

| Type | `props` | `children` |
|---|---|---|
| `Card` | `title`: optional, up to 150 | Any type except `Card`, `Button` and `LinkButton` |
| `Heading` | `text`: 1 to 150 | None |
| `Text` | `text`: Markdown, 1 to 12,000 | None |
| `Fields` | `fields`: 1 to 10 of `{ label, value }`, `label` 1 to 100, `value` 1 to 1,900 | None |
| `Table` | `columns`: 1 to 20 strings. `rows`: 1 to 99 rows, each a list of one string per column | None |
| `Chart` | `kind`: `bar`, `line`, `area` or `pie`. `title`: 1 to 50. `xLabel`, `yLabel`: optional, up to 50. `categories`: 1 to 20 strings, each 1 to 20 and unique. `series`: 1 to 12 of `{ name, values }`, `name` 1 to 20 and unique, `values` one number per category | None |
| `Comparison` | `rows`: 1 to 99 row labels. `options`: 2 to 4 of `{ title, values }`, `title` 1 to 100, `values` one string per row | None |
| `Checklist` | `items`: 1 to 50 of `{ text, done }`, `text` 1 to 300, `done` a boolean | None |
| `Image` | `attachment`: `attachment:<id>`, one of the message's own attachments. `alt`: 1 to 2,000 | None |
| `Note` | `text`: 1 to 300 | None |
| `Divider` | None | None |
| `Actions` | None | 1 to 5, each a `Button` or a `LinkButton` |
| `LinkButton` | `label`: 1 to 75. `url`: an `https` URL, up to 3,000 | None |
| `Button` | `label`: 1 to 75. `style`: optional, `primary` or `danger` | None |

- A `Chart` of kind `pie` has one series, at most 12 categories, and values greater
  than 0. Bars are grouped, not stacked. Bar, line and area values may be negative.
- A table cell, a field value and a comparison value are plain text. A `Text` is
  Markdown.
- A UI has at most 100 elements, at most one `Table` or `Comparison`, and at most
  two charts. Its table cells, the header included, hold at most 10,000 characters
  together.
- Load an `Image` through the message's attachment, as for an inline image. Load
  nothing from another host.

### `content`

`content` writes each element as plain text, in order: a heading or a card title as
a line in bold, a table or a comparison as a Markdown table, a chart as its title
followed by one line per category, a checklist as `- [x]` and `- [ ]` lines, an
image as an inline image reference (`![alt](attachment:<id>)`), so the message's
attachment is marked `inline`, a link button as its label and URL, and the buttons of an
`Actions` as one line of labels.

### `POST /agents/generated-ui/:id/press`

The body is `{ "elementId": "keep" }`, the id of a `Button` in the block. The first
press wins, and the button's label becomes one message from the person who
pressed. A retry of a press that was taken answers 409 with the pressed block.

| Status | Body | Meaning |
|---|---|---|
| 200 | `{ ui }` | The press was taken. |
| 202 | `{ ui, replyPending: true }` | The press is stored, and the agent's reply starts after the runtime next restarts. |
| 400 | `{ error }` | `elementId` is not a `Button` of this block. |
| 404 | `{ error }` | No such block in a conversation this client can see. |
| 409 | `{ error, ui }` | A button was already pressed. `ui` is the stored block, which the client shows. |
| 503 | `{ error }` | The agent is still starting. |

## Reconnecting

- Reconnect with a backoff. Reset the backoff only after a connection has stayed
  open for 30 seconds.
- Resume with your cursor on every reconnect.
- The server can close a socket for these reasons:

| Close code | Meaning | What to do |
|---|---|---|
| 4426 | Protocol version not supported | Tell the person to update. Do not reconnect. |
| 4408 | No `hello` in time | Reconnect. |
| 4008 | The socket fell too far behind | Reconnect and resume. |
| 4001 | A newer connection replaced this one | Reconnect only if this client is still in use. |

## Several clients at once

- Every event goes to every connected client, including the one whose request
  caused it.
- Two messages sent to the same conversation at the same time are both stored,
  in the order they arrive. The later one reaches the agent while it is still
  working on the earlier one.
- An agent works on one conversation at a time. A message for another
  conversation waits, and every client sees that conversation as `queued`.
- Drafts, read markers and scroll position belong to each client. They are not
  shared.
