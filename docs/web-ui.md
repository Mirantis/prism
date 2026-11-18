# Web UI

The runtime serves a browser UI on the same port it listens on. Open it at:

```
http://localhost:3003
```

(In local development with Vite it's at <http://localhost:5173>, which proxies
to the runtime.)

![Prism Agent Web UI](images/web-ui.png)

The left sidebar groups the pages: **Overview** and **Chat**; **Channels**,
**Scheduled Tasks** and **Webhooks**; **Profile** and **Activity**. **New chat** at
its top starts a conversation from any page, and the dot on the agent's mark shows
what it is doing right now (green idle, blue working, red error). Press **Ctrl+B**
(**⌘B** on a Mac), or the button at the top left, to collapse the sidebar to icons.

Press **Ctrl+K** (**⌘K** on a Mac), or **Search** in the sidebar, to open the command
palette. Type part of a page's name, or of the name of one of your 300 newest
conversations, then press **Enter** to go there. **New chat** and **Toggle sidebar** are
there too.

## Overview

The landing page. It shows the agent's status (Working / Idle / Error), its
model, and four cards: heartbeat state, linked Slack channels, scheduled tasks,
and tokens used in the last 24 hours. Each card opens the page that manages it.
Below them are your most recent conversations, and a setup checklist that ticks
off each step you have done and marks the next one. (To rename the agent, use the
Name field on the [Profile](#profile) page.)

When no LLM provider is configured, a warning at the top of the Overview names the
setting to add. The agent answers messages after you add it and restart Prism.

On a native install, a strip under the header announces a newer release with an
**Update now** button, shows "Backend updating…" while the runtime restarts, and
reloads the page when it's back — see
**[Automatic updates](installation.md#automatic-updates)**.

## Chat

The main conversation surface.

- **Sending messages.** Type in the input pinned to the bottom and press send.
  Responses **stream** in as the agent works — you see intermediate text from
  multi-step responses in real time rather than one block at the end. An empty
  conversation offers a few first messages; press one to send it.
- **Reading back.** A line with the day separates messages sent on different
  days. Older messages load as you scroll up. While you read further up, new
  messages do not move the view; press **Jump to latest** to return to the end.
- **Slash commands.** Type `/` to open a command popup, the same as the
  **[Terminal UI](terminal-ui.md#slash-commands)**: filter by typing, arrow keys
  to move the selection, **Tab** or **Enter** to complete it, then **Enter** to
  run. The web supports
  `/help`, **`/skills`** (list installed [skills](skills.md), or `/skills run
  <name>`), **`/plugins`** (list installed [plugins](plugins.md) and what each
  contributes), **`/goal`** (set or manage a background goal — `/goal
  <objective>`, `status`, `list`, `pause`, `resume`, `stop`), **`/compact`**
  (summarize older history to free up context — see
  **[Compaction](compaction.md)**), and **`/update`** (install a newer Prism
  release — see **[Automatic updates](installation.md#automatic-updates)**;
  native installs only). Commands run
  locally and call the runtime directly; their output appears as a system note
  in the conversation, and `/goal`/`/skills run` stream the agent's reply in.
  A one-line note renders as a centered aside; a listing (`/skills`, `/plugins`)
  renders as a normal left-aligned block so the list is readable.
- **Voice calls.** Press the phone at the top right to talk to the agent out
  loud. A bar above the conversation shows the call, with mute and hang-up, and
  the call adds no message to the thread — see **[Voice chat](voice-chat.md)**.
- **Voice messages.** Press the microphone beside the send button and speak; the
  browser asks for the microphone the first time. Press send, and your words
  arrive in the thread as your message. ✕ discards the recording — see
  **[Dictation](dictation.md)**.
- **Attachments.** Attach files with the paperclip button or by drag-and-drop.
  Pending attachments show as chips (with a progress spinner, name, and size)
  and can be removed before sending (up to 100 per message). Attached files are
  **not** auto-inlined into the context — the agent sees a metadata stub
  (filename, type, size) and inspects the contents on demand using its
  [attachment tools](tools.md#attachments). Images can be viewed visually;
  other files are hydrated to disk and read with shell tools. File content is
  kept for 7 days unless [`ATTACHMENT_TTL_HOURS`](configuration.md#core) sets
  another time; after that the chip shows **Expired** and the file can no
  longer be downloaded — share it again if needed.
- **Stopping.** While the agent is responding, a stop button appears next to
  send. It cancels the in-flight turn.
- **Several tabs, browsers or devices.** Every open chat shows the same
  conversation as it happens: your messages, other people's messages with their
  names, and whether the agent is working. The agent also knows who wrote each
  message. Any of them can stop the agent. A chat that lost its connection
  catches up when it reconnects.
- **Waiting.** The agent works on one conversation at a time. A message sent to
  another conversation meanwhile shows as waiting, and is answered next.
- **A message that could not be sent** is marked in the conversation, with
  **Retry** and **Edit**.
- **After an update**, a banner asks you to reload the page before you keep
  chatting.
- **Steering a response in progress.** You can keep typing while the agent
  works, and **Enter sends** — send stays live for the whole turn, alongside
  stop. A message sent mid-response is handed to the turn already running: the
  agent picks it up at its next step and changes course, instead of a second
  turn queueing behind the first. Anything that arrives too late for the running
  turn is answered together in one follow-up rather than one reply per message.
  Stop still means "stop the turn" — it never clears what you have typed. One
  caveat: if you stop a turn before it has picked your mid-turn message up, that
  turn never answers it. The message stays in the conversation and the agent
  reads it as history next time, but nothing replies to it there and then. A
  message you send after you stop gets a reply of its own. The
  **[Terminal UI](terminal-ui.md#chatting)** and [Slack](slack.md) behave the
  same way.
- **Tool calls.** When the agent uses a tool, the message shows an
  expandable section with the tool name, its input, and its output — so you can
  see exactly what it did.
- **Markdown & downloads.** Agent messages render as markdown (headings, lists,
  code blocks, links). Files the agent shares back appear as downloadable chips.
  The copy button under a reply, and the one on each code block, copy it to the
  clipboard.
- **Threads.** Each conversation is a thread. The 300 newest are listed in the
  sidebar under **Chat**, grouped by the day they started; click one to reopen
  it. Once the list is six or more, a filter box above it narrows it by title. Start a fresh conversation with **New chat**, or the pen
  button next to the **Recents** heading — clicking
  it again while the new thread is still empty reuses that thread instead of
  piling up empty ones. The thread ID is in the URL (`/chat/<threadId>`), so
  conversations are deep-linkable. A new thread is also created automatically
  on your first message, and gets an auto-generated title once it has content.
- **Connection status.** A small indicator shows the live WebSocket connection
  state (connected / connecting / disconnected / error); it reconnects
  automatically. Send and stop are both disabled while the connection is down —
  neither can reach the agent — and re-enable on reconnect. What you have typed
  is left alone.
- **Context used.** Above the input, the right-hand side shows how much of the
  model's context window this conversation has consumed — e.g. `58% context
  used`. Hover it for the exact token counts and the model they were measured
  against. It updates live as the agent works, and survives a page reload. It is
  hidden when the agent is set to a model the runtime doesn't recognize — see
  `CONTEXT_WINDOW_TOKENS` in the **[configuration reference](configuration.md)**.

  The **[Terminal UI](terminal-ui.md#status-bar)** shows the same figure, in a
  more compact `| context 58%` form.

  When the window fills up, the runtime **[compacts](compaction.md)** the
  conversation: older history is folded into a summary and the meter drops.
  While that runs, a `Compacting conversation…` note appears in the strip above
  the input, and a system note (`Conversation compacted — N older messages
  summarized.`) lands in the chat when it finishes. `/compact` triggers the same
  thing manually.

### Questions from the agent

When the agent asks for your decisions as a card, choose your answers and send
them, or type a reply instead. On a card with several questions you can skip any
of them, as long as one has an answer. Anyone in the conversation can answer, and
the first answer counts.

If the card says **Your answers are saved. The reply is delayed.**, your answers
are safe and the reply comes later. If it says **Couldn’t send these answers.
Reload the page to see the current questions.**, reload the page and answer the
questions shown.

### One conversation

With `THREAD_MODE=single` the agent keeps one conversation. **Chat** always opens
it, and there is no **New chat**, no **Recents** and no list of conversations on
the Overview or in the command palette. Scheduled tasks, goals and heartbeats post
into it, and [compaction](compaction.md) keeps it inside the model's window.
Slack and Teams threads stay separate conversations.

When you switch an agent to `single`, it keeps the conversation you wrote in last.
The other conversations come back when you switch to `multi` again. A goal that
was running in one of them stops, with a note in the one conversation; start it
again there.

## Channels

Link the agent to Slack and Microsoft Teams here. Each configured integration
gets its own section; the page reflects whether one is configured at all
(Slack needs `SLACK_BOT_TOKEN` + `SLACK_APP_TOKEN`, Teams needs
`TEAMS_APP_ID` + `TEAMS_APP_PASSWORD` + `TEAMS_APP_TENANT_ID` in the runtime's
environment — see **[Slack](slack.md)** and **[Microsoft Teams](teams.md)**).

Two modes:

- **Personal Mode (DM).** Link your Slack account so you can DM the agent.
  Click **Link Account** to generate a six-character verification code (it
  expires in ~15 minutes), then DM that code to the agent in Slack. Once linked,
  the page shows the linked DM; you can **Unlink** to undo.
- **Team Mode (channels).** Invite the agent to channels. Click **Add channel**
  to generate a channel link code, invite the agent to the channel, and post the
  code there. You can link **multiple** channels — they're listed in a table,
  each with an **Unlink** action. One channel is the **main channel** (marked ★);
  it's where heartbeat alerts post. Use **Set main** to move it. The first
  channel you link becomes main by default.

Personal and Team modes are mutually exclusive — unlink one before switching to
the other.

The **Microsoft Teams** section works the same way: **Link Account** issues a
code you send to the agent in a Teams personal chat; **Add channel** issues a
code you @mention the agent with in a Teams channel; linked channels list with
**Set main** / **Unlink** actions. See **[Microsoft Teams](teams.md)**.

The page also manages **heartbeat triggers** (Slack only): designate a Slack
channel so that incoming messages wake the agent's heartbeat, with a
configurable throttle (minutes : seconds) between triggers. See
**[Heartbeat](heartbeat.md#slack-triggered-heartbeats)**.

## Scheduled Tasks

List, create, edit, and delete the agent's cron-driven runs.

- Each task in the list shows its name, its instruction, its schedule as a cron
  expression (e.g. `0 9 * * *`) and, for a common schedule, in words, whether it
  is active, its next and last run, and where it delivers when that is not all
  channels.
- **Create** opens a form: a name, a cron expression, and an optional
  instruction describing what the agent should do on each tick. Common schedules,
  such as **Weekdays at 09:00**, fill in the expression with one press. The form
  names the agent's time zone, which every schedule runs in. **May post to** sets
  where the run may post, as for a [webhook](webhooks.md#delivery-targets--storage).
- **Edit** (the pencil on a task) opens the same form with the task's name,
  schedule, instruction and delivery.
- **Delete** removes a task after a confirmation.

The Web UI's form takes raw cron expressions. (The agent itself, and the
TUI, also accept natural-language schedules like "every weekday at 9am" — see
**[Scheduled tasks](scheduled-tasks.md)**.)

## Webhooks

Let external systems trigger the agent by POSTing JSON to a named endpoint.

- **Webhook receiver** starts disabled. Turn it on to open the webhook port;
  turning it off closes the port immediately and keeps your subscriptions.
- **New subscription** creates a named route (`/agents/webhooks/<name>`). It
  starts with the name, description and event-type filter, then two sections:
  **Delivery** (target — All channels / Chat / Slack / Microsoft Teams / None,
  and for Slack the linked channels to post to — a **deliver only** mode that
  posts the rendered template without running the agent, and the prompt
  template) and **Authentication**.
- **Authentication** starts with a **Scheme** — a shared token in a header or an
  HMAC signature of the body — which reveals the **Header**, **Prefix** and
  **Secret** fields (plus **Algorithm**/**Encoding**/**Signed URL** for HMAC).
  It's generic: you name the header your sender uses, so there's nothing
  vendor-specific to pick. Header and Secret are required once a scheme is
  chosen: **Create** stays disabled until both are filled in (as does **Save**
  in the **Edit** dialog, where an empty Secret keeps the stored one).
- Each row shows the endpoint path with a button that copies its full URL on
  the webhook port, the **Auth** scheme (`Unverified` when there is none), an
  **Active** switch (disabled subscriptions reject events), an **Edit** action
  that opens the form with every setting but the name, and a delete action. On
  narrow screens, cards keep authentication, the full endpoint URL, and these
  controls together.

See **[Webhooks](webhooks.md)** for the endpoint contract, prompt-template
syntax, the authentication recipes, and copy-paste
Alertmanager/PagerDuty/GitHub configs.

## Profile

The agent's identity and runtime controls.

- **Name.** Edit the agent's display name inline: up to 64 characters of letters, digits, spaces and `- ' . &`.
- **Models.** **Fixed** runs every turn on one model; **Reset to default**
  returns it to the runtime default. **Heartbeats** and **Scheduled tasks** can
  each use their own model; leave one empty to use the chat model. **Auto** runs
  each turn on your **Small**, **Medium** or **Large** model. Auto needs a small
  and a large model; choosing it before both are set asks for them, and **Save and
  turn on Auto** applies the change.
  See **[Configuration → Models](configuration.md#models)** and
  **[Auto model selection](configuration.md#auto-model-selection)**.
- **Chat delivery.** A toggle switches between **Concise** (default) and
  **Verbose** mode. In concise mode only the agent's final message is delivered;
  intermediate steps are persisted but not shown. See
  **[Configuration → Chat verbosity](configuration.md#chat-verbosity)**.
- **Locked-in mode.** A toggle freezes the agent's identity documents and its
  long-term memory against its own tools — Soul, User, Memory, Vision, Heartbeat
  and Bootstrap become read-only to it, and it can no longer add or delete
  long-term memories, while settings, renames and memory search keep working. The
  **Agent** guide is not in that list: no tool writes it, so it is read-only to
  the agent either way. Your own editing is unaffected — every tab keeps saving
  while the lock is on. The agent cannot turn this off itself. It is a guardrail against drift,
  not a security boundary; the known ways around it are listed under
  **[Configuration → Locked-in mode](configuration.md#locked-in-mode)**.
- **Identity documents.** Seven tabs hold the agent's markdown documents —
  **Agent** (guide), **Soul**, **User**, **Heartbeat**, **Memory**, **Vision**,
  and **Bootstrap**. Each one is an editor: change the text and press **Save**,
  and the agent picks it up on its next turn. Saving the **Heartbeat** document
  also restarts the heartbeat. Add an optional note about what changed, which the
  history keeps. The **Version history** sidebar compares a selected version with
  the current document and lets you restore it. See
  **[The agent's identity](agent-identity.md#version-history)**.
- **Heartbeat controls.** A status panel shows whether the heartbeat is Active
  or Stopped, its interval, the last run time, and a consecutive-error count.
  Buttons let you **Start**, **Stop**, or **Trigger now**, and you can edit the
  interval inline (1–10080 minutes). **May post to** sets where a heartbeat may
  post. See **[Heartbeat](heartbeat.md#where-a-check-posts)**.
- **Coding agents.** One row each for Claude Code and Codex shows whether its
  coding tasks use the deployment's models or your own subscription, with the
  plan and email you signed in with. **Sign in** opens a dialog that links to
  Claude's or OpenAI's sign-in page. **Sign out** sends coding tasks back to the
  deployment's models. With `CLAUDE_CODE_SUBSCRIPTION` or `CODEX_SUBSCRIPTION`
  set, **Sign out** only removes the login, and tasks fail until you sign in
  again. A link the agent sends in chat to ask you to sign in opens this page
  with the dialog open.
  See **[Configuration → Coding tasks on a Claude subscription](configuration.md#coding-tasks-on-a-claude-subscription)**
  and **[Codex tasks on a ChatGPT subscription](configuration.md#codex-tasks-on-a-chatgpt-subscription)**.
- **Backup & restore.** **Export** downloads a `.prism` snapshot of the entire
  agent — chat history, memory, scheduled tasks, settings, and Slack mappings.
  **Restore** replaces the agent from a `.prism` file (a destructive operation;
  the runtime restarts and the page reconnects when it's back).

## Computer

Watch Prism use its desktop, take control when it needs help, or start optional
voice chat — where you can also share your own screen or record yourself working
through something. Work continues when you leave the page. The page also lists
the computers of yours that Prism can use, and whether each one is connected.

See **[The agent's computer](computer.md)**.

## Activity

What the agent has spent, and what it has done.

- **LLM usage.** Four figures for the last 24 hours: total tokens, the input and
  output split, and the share of the prompt served from the cache. Input counts
  the whole prompt, cache included. Each card shows the rounded figure large and
  the exact count beneath it. A table below the cards splits the same window by
  model.

  Counts every text-generation call, including the ones that produce no
  message. Voice meetings and memory embeddings each run on their own surface,
  billed separately from these figures.

  **Cache hit rate** reads `—` when the provider reports no cache breakdown, and
  `0%` when it reports one and nothing was served from cache. See
  **[Configuration → Provider selection](configuration.md#provider-selection)**.

- **Webhook runs.** Every event a [webhook](webhooks.md) accepted, newest first,
  with the webhook's name, the time and the result: **Completed**, **Failed**,
  **Spending limit reached**, **Nothing to report** when the reply was held back,
  or **Delivered** for a deliver-only webhook. A run that has not finished reads
  **Queued** or **Running**. A run a restart interrupts runs again after the
  restart, and reads **Failed** when it cannot: a deliver-only event, or a
  webhook deleted in the meantime.
  Expand a run to see the message it delivered and the tool calls it made. When
  it delivered to web chat, **Open conversation** opens that chat. The 1,000
  newest finished runs are kept.

- **Tool calls.** The tool calls the agent has stored, newest turn first, across
  every conversation, running back through the whole history.

  Each row names the tool and previews its most telling argument, with a green
  dot for a call that succeeded and a red one for a call that failed. Expand a
  row to see the call's parameters and its output; a long output has a **Show
  full output** link. A call from an autonomous turn is badged with what started
  it.

  Long values are cut: 2,000 characters of parameters and 10,000 of output, with
  a note in place of the rest.

## Behind the scenes

The Web UI is a single-page app that talks to the runtime over its REST API and
a WebSocket at `/api/ws` for real-time chat, typing indicators, status changes,
and thread updates. There's no separate login for the bundled single-agent
runtime — it serves your one agent directly.
