/**
 * Slack Working Indicator
 *
 * Visible "working" cue while a user-initiated Slack turn runs:
 *
 *  - an assistant-thread status line on the reply thread — the primary cue —
 *    pushed event-driven: set at begin, set again whenever the text changes
 *    (a tool starts or finishes) and after each message the adapter posts
 *    into the thread (Slack clears the status on any bot post), and cleared
 *    when the turn ends — Slack never expires it otherwise, so every exit
 *    path must clear it explicitly or it sticks forever. A thread whose
 *    initial set fails is on the fallback cue for the rest of the turn, so
 *    its later pushes are skipped instead of re-attempted; only the final
 *    clear still goes out; and
 *  - an `eyes` reaction on the triggering user message — the fallback cue:
 *    added only when the thread's initial setStatus fails, or right away
 *    when the turn has no status thread at all (a top-level DM). The
 *    fallback decision is made once per status entry, so a steered turn
 *    sharing the thread shares the outcome and a re-set failing later never
 *    adds a late reaction. The reaction is removed when the turn ends — only
 *    if it was added, and never swapped for a success or failure emoji. On
 *    the fallback path it appears one Slack round trip after the turn starts.
 *
 * The Slack API calls are injected as {@link SlackIndicatorOps}. setStatus
 * is expected to reject when the status cannot be set — that rejection is
 * the fallback signal; the reaction ops are expected to swallow their own
 * errors. This module still guards every call so a misbehaving op can
 * neither fail a turn nor produce an unhandled rejection.
 */

import { logger } from '../logger';
import type { ToolLifecycleListener } from '../lib/tool-lifecycle';

export const WORKING_REACTION = 'eyes';
export const WORKING_STATUS_TEXT = 'is thinking…';

export interface SlackIndicatorOps {
  addReaction(channelId: string, messageTs: string, teamId: string, emoji: string): Promise<void>;
  removeReaction(channelId: string, messageTs: string, teamId: string, emoji: string): Promise<void>;
  /** Must reject when the status cannot be set — the reaction-fallback signal. */
  setStatus(teamId: string, channelId: string, threadTs: string, status: string): Promise<void>;
}

export interface WorkingIndicatorTarget {
  teamId: string;
  channelId: string;
  /**
   * ts of the triggering user message — reaction target: the fallback cue,
   * or the only cue when statusThreadTs is absent. Absent → no reaction.
   */
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
   * default text. Pushed to Slack as soon as the thread's previous status call
   * is done; changes made while a push waits are coalesced into it, so only the
   * latest text is sent. No-op without a status thread or after end().
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
  /**
   * Outcome of this entry's initial setStatus — the fallback decision, made
   * once per entry: turns sharing the entry (a steered message) gate their
   * reaction on the same result, and later re-sets never revisit it. Never
   * rejects.
   */
  statusOk: Promise<boolean>;
  /**
   * Mirrors a false {@link statusOk} synchronously, for the push paths to
   * read. Once the initial set failed the turn is on the reaction fallback
   * and every later push would fail the same way, so pushing again buys
   * nothing but rate-limit pressure. Per entry rather than per thread: the
   * next turn on the thread builds a fresh entry and tries again, so one
   * transient failure disables the cue for one turn only.
   */
  statusFailed: boolean;
  /**
   * A text push is queued on the thread's op chain and has not started yet. It
   * sends {@link text} as it is when it starts, so a change made meanwhile rides
   * along instead of queuing a call of its own. A program making hundreds of
   * quick tool calls flips the text twice per call; without this every flip was
   * a Slack call, and the final clear waited behind all of them.
   */
  pushQueued: boolean;
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
  private statusOpChains = new Map<string, Promise<boolean>>();
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

    let ended = false;
    // Ending the turn takes the add off the table, so the decision below
    // races the status outcome against this signal — the reaction decision
    // must not sit out a slow or stuck setStatus round trip just to learn
    // nothing will be added. The owning turn's clear still queues behind that
    // round trip on the entry's op chain (see releaseStatus); only this
    // decision, and a steered turn's end(), are freed by the race.
    let signalEnded!: () => void;
    const endedSignal = new Promise<'ended'>((resolve) => {
      signalEnded = () => resolve('ended');
    });

    // Reaction decision — fire-and-forget from begin()'s point of view, so
    // the turn is not delayed by a Slack round trip. Without a status entry
    // (a top-level DM) the add is issued synchronously right here, as the
    // only cue; with one, the add waits for the entry's initial setStatus
    // and fires only when that failed — unless the turn already ended, where
    // the cue could never be seen and would only have to be removed again.
    // Resolves true iff the add was attempted, and never rejects (safely()).
    // end() awaits it before removing, so the remove can never overtake the
    // add; and the handle is registered synchronously below, so a stopAll()
    // firing while the decision is in flight still finds and ends this turn.
    const reactionAdded: Promise<boolean> = (async () => {
      if (!messageTs) return false;
      if (entry) {
        const outcome = await Promise.race([entry.statusOk, endedSignal]);
        // Skip on success ('true'), on end-before-outcome ('ended'), and on
        // an end that lands after the outcome but before this continuation.
        if (outcome !== false || ended) return false;
      }
      await this.safely('reactions.add', () =>
        this.ops.addReaction(channelId, messageTs, teamId, WORKING_REACTION));
      return true;
    })();

    const handle: WorkingIndicatorHandle = {
      setText: (text: string | null) => {
        // statusFailed: this thread showed the reaction instead, and the phrase
        // has nowhere to render — pushing it buys another rejection.
        if (ended || !entry || !statusThreadTs || entry.statusFailed) return;
        // Identity check: a stale handle must not write into a newer turn's entry.
        const key = this.statusKey(teamId, channelId, statusThreadTs);
        if (this.statusEntries.get(key) !== entry) return;
        const next = text ?? WORKING_STATUS_TEXT;
        if (next === entry.text) return;
        entry.text = next;
        if (entry.pushQueued) return; // the queued push will send this text
        entry.pushQueued = true;
        void this.runStatusOp(key, 'assistant.threads.setStatus', async () => {
          entry.pushQueued = false;
          // The turn ended while this waited (its clear is queued behind), or the
          // initial set failed and the thread is on the reaction fallback.
          if (this.statusEntries.get(key) !== entry || entry.statusFailed) return;
          await this.ops.setStatus(teamId, channelId, statusThreadTs, entry.text);
        });
      },
      end: async () => {
        if (ended) return;
        ended = true;
        signalEnded();
        this.activeHandles.delete(handle);
        const added = await reactionAdded; // never rejects (safely)
        if (entry) {
          await this.releaseStatus(teamId, channelId, statusThreadTs!, entry);
        }
        if (added && messageTs) {
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
   * mid-turn intermediate replies. No-op when no turn is live on the thread,
   * and once the thread's initial set failed. The final reply also sets it;
   * end()'s clear lands after it on the same per-key op chain, so the final
   * state stays cleared.
   */
  setStatus(teamId: string, channelId: string, threadTs: string): void {
    const key = this.statusKey(teamId, channelId, threadTs);
    const entry = this.statusEntries.get(key);
    // No entry: no turn is live on the thread. statusFailed: the cue cannot
    // come back this turn, so a turn posting N intermediate replies would
    // otherwise issue N more rejected calls, one per post.
    if (!entry || entry.statusFailed) return;
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
   * behind. Resolves with the op's outcome (true = the op resolved).
   */
  private runStatusOp(key: string, what: string, op: () => Promise<void>): Promise<boolean> {
    const prev = this.statusOpChains.get(key) ?? Promise.resolve(true);
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
    // The initial set doubles as the fallback decision: its outcome is cached
    // on the entry for every turn that shares it. It deliberately sends
    // WORKING_STATUS_TEXT rather than entry.text — the entry does not exist
    // yet, and a setText racing in behind just queues a correctly-ordered
    // second op.
    const statusOk = this.runStatusOp(key, 'assistant.threads.setStatus', () =>
      this.ops.setStatus(teamId, channelId, threadTs, WORKING_STATUS_TEXT));
    const entry: StatusEntry = {
      refCount: 1,
      text: WORKING_STATUS_TEXT,
      statusOk,
      statusFailed: false,
      pushQueued: false,
    };
    this.statusEntries.set(key, entry);
    // Log the outcome once per entry (not per push — a long turn should not
    // narrate itself). The status line is write-only on the Slack API, so this
    // is the only signal that the primary cue rendered, and the only place the
    // fallback announces itself; the e2e suite asserts on these phrases.
    void statusOk.then((ok) => {
      if (ok) {
        logger.info('Slack thread status accepted (channel=%s, thread=%s)', channelId, threadTs);
        return;
      }
      entry.statusFailed = true;
      logger.info(
        'Slack thread status rejected - falling back to the %s reaction (channel=%s, thread=%s)',
        WORKING_REACTION,
        channelId,
        threadTs,
      );
    });
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

  /**
   * Run an op, swallowing (and debug-logging) any rejection. Resolves true
   * when the op resolved and false when it threw — for setStatus, the
   * reaction-fallback signal.
   */
  private async safely(what: string, op: () => Promise<void>): Promise<boolean> {
    try {
      await op();
      return true;
    } catch (error) {
      logger.debug(
        'Slack working indicator %s failed: %s',
        what,
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
  }
}
