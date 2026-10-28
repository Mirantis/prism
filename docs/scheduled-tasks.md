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

A task that asks for a message in another linked channel posts it there with
[Sending messages](tools.md#sending-messages), and its result says what it sent.
The next run of a recurring task sees what the task sent before. A task that
asks for a message on every run sends it on every run. A task that asks for one
only when something happens sends it again only when it happens again.

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

A continuation whose wait is not over yet waits again and posts nothing.

## Quiet when there's nothing to report

A scheduled run posts a message only when its instruction asks for one:

- A task that asks for output **unconditionally** ("send me a daily summary,"
  "remind me at 3pm") posts on every run.
- A **conditional** task ("check the deploy queue and only tell me if something
  is stuck") posts only when the condition is met, and does not post the same
  finding again until something changes.
- A task that asks for **no message** ("just do the work, never tell me about
  it") posts nothing. A run that ends in an error, or in which the
  [risk gate](configuration.md#tool-risk-gate) blocked an action, is posted for
  you all the same.

**May post to** on the task sets where it may post: every linked channel and web
chat (the default), web chat only, Slack or Teams, chosen Slack channels, or
nowhere. Name a place in the instruction ("post it to #releases") to pick one
inside that setting; otherwise the task posts to your DM, else the main channel,
else web chat. A run that posts nothing is still a full run: the task's last-run
timestamp advances and a one-shot still deletes itself.

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

Both post only when there's something worth saying.

- Use the **[heartbeat](heartbeat.md)** for the single standing *monitoring*
  loop with its own configured checks and cadence.
- Use a **scheduled task** for *specific work at specific times* — reports,
  reminders, periodic actions. A task that asks for output unconditionally
  always delivers.
