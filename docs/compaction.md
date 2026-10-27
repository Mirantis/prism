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
- **Manually.** Run **`/compact`** in the web chat or the terminal UI to
  compact the current conversation at any time. If there is nothing to compact
  yet, the command says so.
- **On overflow.** A single turn can outgrow the window outright (the provider
  rejects the request as too long). That rejection triggers a recovery
  compaction immediately: the runtime summarizes the history — shrinking the
  summarized input until it fits — so the next message works again instead of
  every following turn failing the same way.

While a compaction runs, the web UI shows `Compacting conversation…` above the
input and the TUI shows it on the spinner row. When it finishes, a system note
appears in the chat and the context meter drops.

## What survives

- The newest messages stay in the context word-for-word: up to **6** of them,
  together no larger than about 30,000 tokens, starting at one of your
  messages. Your latest request and its reply stay whole even when they are
  more than 6 messages. A reply with very large tool output is summarized
  instead.
- The summary is structured (goal, your requests, important details, current
  state, next steps, relevant files), stays under about 2,000 words, and keeps
  exact paths, commands, error strings and identifiers. It also records what
  tool calls did and returned, because the compacted context contains no raw
  tool calls.
- Lasting facts the summary finds, such as your preferences and details of your
  environment, are saved to the agent's long-term [memory](memory.md), unless
  memory already holds them. Locked-in mode turns this off. Ask the agent to
  forget one you don't want kept.
- To steer what summaries keep, add a `## Compact Instructions` section to the
  [Agent Guide](agent-identity.md#the-seven-documents).

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
| `COMPACTION_TAIL_MESSAGES` | At most this many of the newest messages are kept out of compaction; your latest request and its reply always stay whole | `6` |

Auto-compaction works best when the model's context window is known; see
**[Context-window size](configuration.md#context-window-size)**. For a model
whose window the runtime doesn't recognize, the trigger assumes a conservative
1,000,000-token window instead of leaving the thread unbounded — that
assumption is trigger-only, so the on-screen context meter stays hidden rather
than showing a guessed percentage. Overflow recovery works regardless of
whether the window is known. Set `CONTEXT_WINDOW_TOKENS` to get accurate
triggering and a visible meter.
