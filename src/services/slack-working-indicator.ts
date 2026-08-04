/**
 * Slack Working Indicator
 *
 * Visible "working" cue while a user-initiated Slack turn runs:
 *
 *  - an `eyes` reaction on the triggering user message, added when processing
 *    starts and removed when the turn ends (never swapped for a success or
 *    failure emoji), and
 *  - a best-effort assistant-thread status line on the reply thread, pushed
 *    event-driven: set at begin, set again whenever the text changes (a tool
 *    starts or finishes) and after each message the adapter posts into the
 *    thread (Slack clears the status on any bot post), and cleared when the
 *    turn ends — Slack never expires it otherwise, so every exit path must
 *    clear it explicitly or it sticks forever.
 *
 * The Slack API calls are injected as {@link SlackIndicatorOps}. The injected
 * ops are expected to swallow their own errors; this module still guards
 * every call so a misbehaving op can neither fail a turn nor produce an
 * unhandled rejection.
 */

import { logger } from '../logger';
import type { ToolLifecycleListener } from '../lib/tool-lifecycle';

export const WORKING_REACTION = 'eyes';
export const WORKING_STATUS_TEXT = 'is thinking…';

export interface SlackIndicatorOps {
  addReaction(channelId: string, messageTs: string, teamId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageTs: string, teamId: string, emoji: string): Promise<void>;
  setStatus(teamId: string, channelId: string, threadTs: string, status: string): Promise<void>;
}

export interface WorkingIndicatorTarget {
  teamId: string;
  channelId: string;
  /** ts of the triggering user message — reaction target. Absent → no reaction. */
  messageTs?: string;
  /**
   * Reply-thread ts for the status line. Absent (top-level DM) → no status;
   * for a DM, never synthesize one from the message ts — that can activate a
   * Slack assistant thread before the reply exists. A channel mention DOES
   * pass its own message ts: the reply always lands in that thread.
   */
  statusThreadTs?: string;
}

export interface WorkingIndicatorHandle {
  /** Idempotent: the first call clears the cues, later calls are no-ops. */
  end(): Promise<void>;
  /**
   * Set the live working phrase ("is running kubectl…"); `null` reverts to the
   * default text. Pushed to Slack immediately when the text changes. No-op
   * without a status thread or after end().
   */
  setText(text: string | null): void;
}

/**
 * The live phrase for the running tools: `is running kubectl…`,
 * `is running kubectl and pwd…`, `is running x, y and z…`. Parallel calls of
 * the same tool collapse into one name. Expects at least one name — the
 * caller reverts to the default text (via `setText(null)`) when none runs.
 */
export function toolStatusText(toolNames: readonly string[]): string {
  const names = [...new Set(toolNames)];
  const list = names.length <= 1
    ? (names[0] ?? '')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  return `is running ${list}…`;
}

/**
 * Mirror a turn's running tools into its status line. The AI SDK executes a
 * step's tool calls concurrently (Promise.all), so mapping each `completed`
 * straight to `setText(null)` would revert the text to the default while a
 * sibling tool is still in flight. The listener instead tracks the running
 * names (a multiset — the same tool can run twice in one step) and always
 * shows every tool still running, reverting only when none is.
 */
export function createToolStatusListener(handle: WorkingIndicatorHandle): ToolLifecycleListener {
  const running: string[] = [];
  return (event) => {
    if (event.type === 'started') {
      running.push(event.toolName);
    } else {
      const index = running.indexOf(event.toolName);
      if (index !== -1) running.splice(index, 1);
    }
    handle.setText(running.length > 0 ? toolStatusText(running) : null);
  };
}

/**
 * One live status line per Slack thread, shared by every turn running on it.
 * Refcounted so a steered message's fast begin/end never clears the status
 * the owning turn still needs (its ref outlives the steered one).
 */
interface StatusEntry {
  refCount: number;
  /** The current status text (default, or a live tool phrase). */
  text: string;
}

/** Returned by begin() after stopAll(): shows nothing, ends as a no-op. */
const INERT_HANDLE: WorkingIndicatorHandle = {
  setText: () => {},
  end: async () => {},
};

export class SlackWorkingIndicator {
  private statusEntries = new Map<string, StatusEntry>();
  private activeHandles = new Set<WorkingIndicatorHandle>();
  /** In-flight status call per thread key; ops chain onto it (see runStatusOp). */
  private statusOpChains = new Map<string, Promise<void>>();
  /** Set by stopAll(); from then on begin() returns INERT_HANDLE. */
  private stopped = false;

  constructor(private ops: SlackIndicatorOps) {}

  async begin(target: WorkingIndicatorTarget): Promise<WorkingIndicatorHandle> {
    const { teamId, channelId, messageTs, statusThreadTs } = target;
    // After stopAll() the Bolt clients are going away — a cue set now could
    // never be cleared, so hand back an inert handle instead.
    if (this.stopped) return INERT_HANDLE;

    const entry: StatusEntry | null = statusThreadTs
      ? this.acquireStatus(teamId, channelId, statusThreadTs)
      : null;

    // Fire-and-forget from begin()'s point of view — the turn is not delayed
    // by a Slack round trip. end() awaits this before removing, so the remove
    // can never overtake the add; and the handle is registered synchronously
    // below, so a stopAll() firing while the add is in flight still finds and
    // ends this turn.
    const reactionAdded = messageTs
      ? this.safely('reactions.add', () =>
          this.ops.addReaction(channelId, messageTs, teamId, WORKING_REACTION))
      : Promise.resolve();

    let ended = false;
    const handle: WorkingIndicatorHandle = {
      setText: (text: string | null) => {
        // Identity check: a stale handle must not write into a newer turn's entry.
        if (ended || !entry || !statusThreadTs) return;
        const key = this.statusKey(teamId, channelId, statusThreadTs);
        if (this.statusEntries.get(key) !== entry) return;
        const next = text ?? WORKING_STATUS_TEXT;
        if (next === entry.text) return;
        entry.text = next;
        void this.runStatusOp(key, 'assistant.threads.setStatus', () =>
          this.ops.setStatus(teamId, channelId, statusThreadTs, next));
      },
      end: async () => {
        if (ended) return;
        ended = true;
        this.activeHandles.delete(handle);
        await reactionAdded; // never rejects (safely)
        if (entry) {
          await this.releaseStatus(teamId, channelId, statusThreadTs!, entry);
        }
        if (messageTs) {
          await this.safely('reactions.remove', () =>
            this.ops.removeReaction(channelId, messageTs, teamId, WORKING_REACTION));
        }
      },
    };
    this.activeHandles.add(handle);
    return handle;
  }

  /**
   * Set the thread's current status again after the adapter posted a message
   * into it — Slack clears the assistant status on any bot post, including
   * mid-turn intermediate replies. No-op when no turn is live on the thread.
   * The final reply also sets it; end()'s clear lands after it on the same
   * per-key op chain, so the final state stays cleared.
   */
  setStatus(teamId: string, channelId: string, threadTs: string): void {
    const key = this.statusKey(teamId, channelId, threadTs);
    const entry = this.statusEntries.get(key);
    if (!entry) return;
    void this.runStatusOp(key, 'assistant.threads.setStatus', () =>
      this.ops.setStatus(teamId, channelId, threadTs, entry.text));
  }

  /** End every live handle (used at adapter shutdown, while clients are still up). */
  async stopAll(): Promise<void> {
    this.stopped = true;
    await Promise.allSettled([...this.activeHandles].map((h) => h.end()));
    // end() empties both collections; sweep defensively.
    this.statusEntries.clear();
    this.activeHandles.clear();
  }

  private statusKey(teamId: string, channelId: string, threadTs: string): string {
    return `${teamId}:${channelId}:${threadTs}`;
  }

  /**
   * Status calls for one thread run strictly in order. Without this, a call
   * still in flight when the next one is issued can land after it on Slack's
   * side — a stale clear wiping the status a newer turn just set, or worse, a
   * set landing after the final clear and leaving a stuck "is thinking…"
   * behind.
   */
  private runStatusOp(key: string, what: string, op: () => Promise<void>): Promise<void> {
    const prev = this.statusOpChains.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.safely(what, op)); // safely() never rejects
    this.statusOpChains.set(key, next);
    void next.then(() => {
      if (this.statusOpChains.get(key) === next) this.statusOpChains.delete(key);
    });
    return next;
  }

  private acquireStatus(teamId: string, channelId: string, threadTs: string): StatusEntry {
    const key = this.statusKey(teamId, channelId, threadTs);
    const existing = this.statusEntries.get(key);
    if (existing) {
      existing.refCount++;
      return existing;
    }
    const entry: StatusEntry = {
      refCount: 1,
      text: WORKING_STATUS_TEXT,
    };
    this.statusEntries.set(key, entry);
    void this.runStatusOp(key, 'assistant.threads.setStatus', () =>
      this.ops.setStatus(teamId, channelId, threadTs, entry.text));
    return entry;
  }

  private async releaseStatus(
    teamId: string,
    channelId: string,
    threadTs: string,
    entry: StatusEntry,
  ): Promise<void> {
    const key = this.statusKey(teamId, channelId, threadTs);
    // Identity check: a stale handle must not decrement someone else's entry.
    if (this.statusEntries.get(key) !== entry) return;
    entry.refCount--;
    if (entry.refCount > 0) return;
    this.statusEntries.delete(key);
    await this.runStatusOp(key, 'assistant.threads.setStatus clear', () =>
      this.ops.setStatus(teamId, channelId, threadTs, ''));
  }

  private async safely(what: string, op: () => Promise<void>): Promise<void> {
    try {
      await op();
    } catch (error) {
      logger.debug(
        'Slack working indicator %s failed: %s',
        what,
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}
