# Scheduled tasks

The agent can put work on its own calendar. A scheduled task is an instruction
plus a time — run once at a moment, or repeatedly on a cadence. Tasks survive
restarts, and the agent can create, list, edit, run, and cancel them itself.

Where the [heartbeat](heartbeat.md) is a single recurring monitoring loop,
scheduled tasks are arbitrary one-off or recurring jobs: "summarize the
overnight alerts every weekday at 9am," "remind me in 30 minutes," "every hour,
check the deploy queue."

## One-shot vs. recurring

- **One-shot** tasks run once and then **delete themselves** — no cleanup
  needed.
- **Recurring** tasks run on their cadence until you cancel them. They track
  their last run, their next run, and a count of consecutive errors.

## Specifying the schedule

You can describe the timing in natural language or with a raw cron expression.
The agent (and the Terminal UI) accept both; the **[Web UI](web-ui.md#scheduled-tasks)**
form takes cron expressions.

**Natural language** (handled when you ask the agent to schedule something):

| You say | Becomes |
|---------|---------|
| "in 30 seconds" | one-shot, 30 seconds from now |
| "in 5 minutes" | one-shot, 5 minutes from now |
| "at 3pm" / "at 14:30" | one-shot at that time (today if still ahead, else tomorrow) |
| "every 2 hours" | recurring, every 2 hours |
| "every 30 minutes" | recurring, every 30 minutes |
| "every day at 9am" | recurring daily at 09:00 |

**Cron expressions** for precise control, e.g.:

```
0 9 * * *       # every day at 09:00
*/15 * * * *    # every 15 minutes
0 9 * * 1-5     # 09:00 on weekdays
```

Schedules run in the agent's configured **timezone** (see
**[The agent's identity](agent-identity.md)**).

## Creating and managing tasks

| Where | How |
|-------|-----|
| Conversation | "Schedule a daily 9am summary of failing pods." or "Move that summary to 8am." The agent creates or changes the task. |
| Web UI | **Scheduled Tasks** page — create (name + cron + instruction + delivery), list, edit, delete. |
| Terminal UI | `/schedules` panel — list, **n** to create, **e** to edit, **d** to delete. |
| Voice meeting | "Look into that and get back to me." The agent schedules a one-off task and says when it runs — see [Voice meetings](voice-meetings.md). |

Each task has a **name**, a **schedule**, and an **instruction** — the prompt the
agent runs on each tick. When a task fires, the agent executes that instruction
with its full toolset and delivers the result to your active conversation (and
to connected channels, labeled as a scheduled-task result) — unless there is
nothing worth reporting (see
[Quiet when there's nothing to report](#quiet-when-theres-nothing-to-report)).

Each task also has a **Deliver to** target, with the same choices as a
[webhook's](webhooks.md#delivery-targets--storage): **All channels** (the
default), **Chat**, **Slack** (optionally to chosen linked channels),
**Microsoft Teams**, or **None**, which runs the task and posts nothing. Set it
in the Web UI form, or ask the agent: "post the daily summary to Slack only."

Scheduled runs use the agent's main model by default, but you can give them
their own model from the **[Web UI → Profile](web-ui.md#profile)** or the
**[Terminal UI](terminal-ui.md#slash-commands)** (`/cron-model <id>`).

## Waiting: continue in the same conversation

Sometimes the agent needs to **wait** for something mid-conversation — "check the
deploy in 10 minutes," "ping me once the build finishes." It does this by
scheduling a **one-off** task that **continues in the current thread** instead of
starting a fresh one. When that task fires, the agent resumes the *same*
conversation — with its full history — and replies right where you left off:

- In **Slack**, the reply lands in the **same thread** (and Slack DM), not as a new
  top-level message.
- In the **web** and **terminal** UIs, it continues the same conversation thread.

A regular scheduled task (without continuation) still behaves as before: its
result is delivered to your latest conversation, labeled as a scheduled-task
result. Continuations pass through the same suppression gate as any other run —
a conditional wait with nothing new stays quiet.

## Quiet when there's nothing to report

Every scheduled run passes through the same
**[DELIVER / SUPPRESS gate](heartbeat.md#the-deliver--suppress-gate)** as the
heartbeat: after the run produces its result, a small, fast model (Claude
Haiku) decides whether it's worth your attention. The gate is
**instruction-aware** — it reads the task's instruction alongside the result:

- A task that asks for output **unconditionally** ("send me a daily summary,"
  "remind me at 3pm") always delivers, even when the result says nothing has
  changed. You asked to hear from it on every run.
- A **conditional** task ("check the deploy queue and only tell me if something
  is stuck") stays silent when the condition isn't met — no "nothing to report"
  noise.
- A task that asks for **no message** ("just do the work, never tell me about
  it") delivers nothing unless the run itself fails: it ends in an error, or the
  [risk gate](configuration.md#tool-risk-gate) blocks one of its actions. A
  failure the agent reports in its own words stays silent. In a long
  instruction, put that sentence first. To hear about every failure, name the
  exception: "never tell me unless it fails".
- The gate also sees the **last result the task delivered**, so a conditional
  check that merely repeats an already-reported finding stays quiet until
  something changes. When a quiet run observes a *different* situation (e.g.
  the incident resolved), that memory is cleared — so if the same condition
  later recurs, it alerts again instead of being mistaken for a repeat. (This
  memory is in-process only and resets when the runtime restarts.)

The gate is **fail-open**: if the classification call errors, the result is
delivered rather than dropped. A run that ends in an error, or in which the
[risk gate](configuration.md#tool-risk-gate) blocked an action, skips the gate
and always delivers. A suppressed run is still a full run — the task's last-run timestamp advances and a one-shot
still deletes itself; only the message is withheld.

## Reliability

- Tasks are stored in the embedded database, so they **persist across
  restarts** — on boot, the runtime reloads all active tasks and reschedules
  them. A run that a restart interrupted, or that was due while the runtime was
  down, runs once at boot.
- One-shot tasks are removed once they run.
- A run that is still executing when the task's next tick fires is not
  overlapped: the new tick is skipped (and logged), never queued or run
  concurrently.

## Heartbeat vs. scheduled task — which to use?

Both stay quiet when there's nothing worth saying — they share the same
DELIVER/SUPPRESS gate.

- Use the **[heartbeat](heartbeat.md)** for the single standing *monitoring*
  loop with its own configured checks and cadence.
- Use a **scheduled task** for *specific work at specific times* — reports,
  reminders, periodic actions. A task that asks for output unconditionally
  always delivers.
