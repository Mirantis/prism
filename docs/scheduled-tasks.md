# Scheduled tasks

The agent can put work on its own calendar. A scheduled task is an instruction
plus a time — run once at a moment, or repeatedly on a cadence. Tasks survive
restarts, and the agent can create, list, run, and cancel them itself.

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
create form takes cron expressions.

**Natural language** (handled when you ask the agent to schedule something):

| You say | Becomes |
|---------|---------|
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
| Conversation | "Schedule a daily 9am summary of failing pods." The agent creates the task. |
| Web UI | **Scheduled Tasks** page — create (name + cron + instruction), list, delete. |
| Terminal UI | `/schedules` panel — list, **n** to create, **d** to delete. |

Each task has a **name**, a **schedule**, and an **instruction** — the prompt the
agent runs on each tick. When a task fires, the agent executes that instruction
with its full toolset and delivers the result to your active conversation (and
to connected channels, labeled as a scheduled-task result).

Scheduled runs use the agent's main model by default, but you can give them
their own model from the **[Web UI → Profile](web-ui.md#profile)**, the
**[Terminal UI](terminal-ui.md#slash-commands)** (`/cron-model <id>`), or as a
bootstrap default in
**[`~/.prism/settings.json`](configuration.md#bootstrap-model-defaults-prismsettingsjson)**;
leave it empty to inherit the main model.

## Reliability

- Tasks are stored in the embedded database, so they **persist across
  restarts** — on boot, the runtime reloads all active tasks and reschedules
  them.
- One-shot tasks are removed once they run.
- Recurring tasks keep a consecutive-error count so a repeatedly failing task is
  visible rather than silently spinning.

## Heartbeat vs. scheduled task — which to use?

- Use the **[heartbeat](heartbeat.md)** for ongoing *monitoring* where you only
  want to hear about it when something's worth reporting — it has a built-in
  DELIVER/SUPPRESS gate.
- Use a **scheduled task** for *specific work at specific times* whose output you
  always want — reports, reminders, periodic actions.
