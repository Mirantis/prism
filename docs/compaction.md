# Compaction

Long conversations eventually outgrow the model's context window. Compaction
keeps a thread usable forever: the runtime folds older history into a single
structured **summary**, keeps the newest messages **verbatim**, and sends the
model `summary + recent messages` instead of the whole transcript. Nothing is
deleted — every original message stays in the database and in the web/CLI
scrollback; compaction only changes what the model sees.

## When it happens

- **Automatically.** After any conversation turn, if the measured context
  occupancy (the same number the
  [context meter](web-ui.md#chat) shows) has reached
  `COMPACTION_THRESHOLD_PERCENT` of the model's window (default **90%**), the
  runtime compacts the thread in the background. The summarization reuses the
  turn's own prompt-cache prefix, so it is fast and cheap.
- **After a scheduled task, heartbeat or webhook run.** Such a run can store its
  result and tool output in the conversation without a turn there. The runtime
  then adds an estimate of what was stored to the last measured occupancy, and
  compacts the thread when the total reaches `COMPACTION_THRESHOLD_PERCENT`. So
  runs that report into a conversation nobody uses for days cannot grow it past
  the window.
- **Manually.** Run **`/compact`** in the web chat or the terminal UI to
  compact the current conversation at any time. If there is nothing to compact
  yet, the command says so.
- **While idle.** With `CHAT_CACHE_TTL=1h`, a conversation of about 200,000
  tokens or more that you leave until shortly before its prompt cache expires is
  compacted, so your next message starts from the summary instead of the whole
  thread. That is about an hour on Claude and about 11 hours on OpenAI. A
  conversation you come back to sooner keeps every message. A restart of the agent
  in between keeps the compaction scheduled. Set `IDLE_COMPACTION=off` to keep the
  longer cache without it; `COMPACTION_THRESHOLD_PERCENT=0` turns it off as well.
- **On overflow.** A single turn can outgrow the window outright (the provider
  rejects the request as too long). That rejection triggers a recovery
  compaction immediately: the runtime summarizes the history — shrinking the
  summarized input until it fits — so the next message works again instead of
  every following turn failing the same way.

While a compaction runs, the web UI shows `Compacting conversation…` above the
input and the TUI shows it on the spinner row. When it finishes, a system note
appears in the chat and the context meter drops.

## What survives

- The newest messages stay in the context word for word, starting at one of
  your messages. A reply with very large tool output is summarized instead.
- The summary is structured (goal, your requests, important details, current
  state, next steps, relevant files) and keeps exact paths, commands, error
  strings and identifiers. It also records what tool calls did and returned,
  because the compacted context contains no raw tool calls.
- When the summary leaves out a detail, the agent reads the original messages
  with its compacted-history tool.

## Repeated compactions

Compaction is **anchored**: when a thread is compacted again, the previous
summary is part of what gets summarized, so the new summary folds it in and
replaces it. A thread carries exactly one summary at a time, and the cost of
summarizing stays bounded no matter how long the conversation runs.

## Slack threads

Slack conversations are compacted too. The runtime re-reads a Slack thread live
from the Slack API on every turn, so instead of marking messages, it records a
**watermark** — the timestamp of the newest summarized reply — and fetches only
newer replies afterwards. The Slack channel itself is never modified.

## Configuration

| Variable | Meaning | Default |
|----------|---------|---------|
| `COMPACTION_THRESHOLD_PERCENT` | Auto-compact at this percent of the model's window; `0` disables auto-compaction | `90` |
| `COMPACTION_TAIL_MESSAGES` | At most this many of the newest messages are kept out of compaction, except that a long latest reply stays whole when it fits | `6` |
| `IDLE_COMPACTION` | `off` stops compacting large conversations while they sit idle under `CHAT_CACHE_TTL=1h` | on |
| `CHAT_CACHE_TTL` | `1h` asks the provider to keep a chat's prompt cache for an hour instead of five minutes, and on OpenAI for 12 hours instead of 30 minutes. It pays when people come back within that time, and costs more when they work in short bursts with long breaks | `5m` |

Auto-compaction works best when the model's context window is known; see
**[Context-window size](configuration.md#context-window-size)**. For a model
whose window the runtime doesn't recognize, the trigger assumes a conservative
1,000,000-token window instead of leaving the thread unbounded — that
assumption is trigger-only, so the on-screen context meter stays hidden rather
than showing a guessed percentage. Overflow recovery works regardless of
whether the window is known. Set `CONTEXT_WINDOW_TOKENS` to get accurate
triggering and a visible meter.
