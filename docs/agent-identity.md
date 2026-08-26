# The agent's identity

A Prism agent isn't a stateless chat session — it has a persistent identity made
of a small set of markdown documents. These documents are always present in the
agent's system prompt, so changing them changes how the agent thinks, talks, and
acts. Together they're the difference between "a model" and "your agent."

All seven live in the embedded database and are visible in the
**[Web UI → Profile](web-ui.md#profile)** tabs and the
**[Terminal UI `/config` panel](terminal-ui.md#config-panel-config)**.

## The seven documents

| Document | Purpose | Who edits it |
|----------|---------|--------------|
| **Soul** | Personality, values, voice, and hard boundaries — the agent's constitution. | You (the agent can update it on request) |
| **User** | What the agent knows about the person/team it works for. | The agent (it keeps this current as it learns) |
| **Memory** | A curated long-term summary the agent always keeps in context. | The agent |
| **Vision** | The user's longer-term goals for the agent to advance proactively. | You |
| **Agent Guide** | The operating manual — how the agent should behave, when to reach out, safety norms, Slack etiquette, coding workflow. | You, directly — the agent has no tool for it |
| **Heartbeat** | The checks the agent runs on its [heartbeat](heartbeat.md) schedule. | You |
| **Bootstrap** | First-run onboarding instructions; cleared once setup is done. | The agent (clears it) |

A note on "who edits it": for six of the documents the split is about intent,
not a hard lock. Documents that capture *your* intent (Soul, Vision, Heartbeat)
are yours to shape; documents that capture what the *agent* learns (User, Memory)
it maintains itself. In practice you shape all six through conversation — you ask
the agent to change its soul or add a heartbeat check, and it uses its
[self-management tools](tools.md#self-management) to rewrite the document.

The **Agent Guide** is the exception: no tool writes it, so the document that
tells the agent how to work is not one the agent maintains, and a drifting
instruction does not come from the agent's own editing.

It is a guardrail against drift, not a security boundary — the same caveat
[locked-in mode](configuration.md#locked-in-mode) carries, and for the same two
reasons. The [shell](tools.md#shell) is never withheld, so `shell_exec` can
write the document straight into `/data/agent.db`; and the Management API takes
no credential from inside the container, so a shell can `PATCH
localhost:3003/agents/agent-guide` as easily as you can from the UI. What this
removes is the ordinary path — a tool the model reaches for while doing its
work — not every path.

## How editing works

There are three ways the documents change:

1. **Through conversation (the normal way).** Tell the agent what you want —
   "from now on, be more concise," "remember that our staging cluster is
   `eu-west-1`," "add a heartbeat check for failing pods." It edits the relevant
   document itself.
2. **You edit the Agent Guide.** Open the **Agent** tab on the Profile page in
   the [Web UI](web-ui.md#profile), change the text and press **Save**; or run
   `/agent-guide` in the [terminal UI](terminal-ui.md), which opens the document
   in your `$EDITOR` and saves what you write. Either way the agent reads the new
   guide on its next turn. Asking the agent to change its guide gets you a
   description of what it would have written, because it has no tool for it.
   Each save sends the whole document and the last one wins, so two editors open
   at once will overwrite each other rather than merge.
3. **On first run.** The **Bootstrap** document drives an onboarding
   conversation that fills in Soul and User for you, then clears itself.

The other six documents are read-only viewers in both UIs.

The agent's own editing stops in
**[locked-in mode](configuration.md#locked-in-mode)**: its document writers are
refused, its long-term memory writes and deletes are refused, and the bootstrap
script is paused. Ask a locked agent to change its soul and it tells you what it
would have changed instead. Your own editing is unaffected — the Agent Guide
editor keeps working while the lock is on.

## The bootstrap flow

On a brand-new agent, the Bootstrap document contains a short onboarding script.
The agent uses it to ask who you are, what you want it to focus on, and how you
like to work — then writes your answers into its Soul and User documents and
calls its "clear bootstrap" tool. After that, the Bootstrap tab is empty and the
agent operates from its now-personalized identity. You only see this once per
agent.

## Settings that travel with the identity

Beyond the documents, a few dials shape behavior and are stored on the agent:

- **Timezone** (default `UTC`) — used for scheduling and daily resets.
- **Heartbeat interval** (default 8 hours) — see **[Heartbeat](heartbeat.md)**.
- **Model** — the LLM it runs on (defaults to the runtime's configured model).
- **Locked-in mode** (default off) — freezes the documents above, plus long-term
  memory writes, against the agent's own tools; see
  **[Configuration → Locked-in mode](configuration.md#locked-in-mode)**.

You can adjust these by asking the agent, or via the Web UI / TUI where exposed.
Locked-in mode is the exception: only the user can change it.
