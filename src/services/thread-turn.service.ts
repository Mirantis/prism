/**
 * Thread Turn Service
 *
 * The one per-thread primitive: turns on a thread run one at a time, FIFO, and
 * the turn that owns a thread has a mid-turn inbox.
 *
 * Two rules, one object, because they are the same rule seen twice:
 *
 * 1. **Exclusive.** Every model invocation on a thread — interactive chat turns
 *    and background goal turns alike — runs under the thread's mutex, so two of
 *    them never build context from the same thread concurrently.
 *
 * 2. **Steerable.** A chat turn *claims* the thread. A claim takes hand-overs
 *    from the instant it claims until it closes or releases: in that time a
 *    message arriving on that thread is handed to it (`claimOrOffer`, `offer`)
 *    instead of starting a turn of its own. A turn releases once it has answered
 *    everything, and a cancelled one closes at the stop (`close`). The claiming turn picks the message up at its next step boundary —
 *    text and any files alike — so the user can redirect work in flight instead
 *    of waiting minutes for a turn that then answers a question the agent has
 *    moved past.
 *
 * Without this, a message arriving mid-turn started a *second* turn that queued
 * behind the lock. By the time it ran, the first turn had appended its own
 * replies, so the assembled history no longer ended on that user's turn — which
 * Bedrock/Anthropic reject outright ("This model does not support assistant
 * message prefill. The conversation must end with a user message."), and each
 * failed turn's error reply then terminated the next queued turn's history in
 * turn, cascading.
 *
 * **Why a claim and not "is it invoking right now".** The claim is what makes
 * the offer-vs-own decision atomic. It is taken synchronously, in the same tick
 * as the decision it follows, and *before* the owner does any of its own work:
 * before it stores the message, before it waits for the mutex, before it builds
 * context. Any signal derived from the invocation itself would start only after
 * those awaits, and a message landing in between would find the thread free,
 * start a turn of its own, and hit the prefill failure above.
 *
 * A caller that takes the mutex without claiming (the goal loop, via `run()`) is
 * simply not steerable: an autonomous turn is not redirected by a user message.
 *
 * Channel-agnostic: transports (channel adapters, WS gateway) never touch this —
 * they call the conversation engine, which owns the offer/own/coalesce decision.
 */

import { logger } from '../logger';
import type { AgentMessageOrigin } from '../types';

/**
 * A message waiting to reach the turn that owns a thread.
 *
 * Files travel as ids, not bytes: this is pushed from a synchronous `offer()`,
 * and whoever takes the message loads the bytes on its own side.
 */
export interface PendingMessage {
  /** The stored message's id, so the turn that answers it can say so. */
  id: string;
  text: string;
  /** Ids of already-uploaded attachments the message carried. */
  attachmentIds: string[];
  /** Set when another agent sent it, so the turn reads it as that agent's. */
  agentMessage?: AgentMessageOrigin;
}

/** One claim's messages, oldest first. */
type Inbox = PendingMessage[];

interface ThreadState {
  /**
   * Tail of the FIFO queue. Each mutex acquisition chains onto the previous tail
   * and installs its own, so callers are served in arrival order. Tails only
   * ever resolve — a failed turn must not poison the next waiter.
   */
  tail: Promise<void>;
  /** Mutex acquisitions queued or running; keeps the entry alive. */
  refs: number;
  /** The inbox of the claim that takes hand-overs now, or null when the thread is free. */
  accepting: Inbox | null;
  /** The inbox of every claim not yet released, the accepting one and any closed one. */
  open: Set<Inbox>;
  /** Callers of `claimWhenFree`, each given the claim in turn when the one before stops taking hand-overs. */
  queued: Array<(claim: ThreadClaim) => void>;
}

/**
 * The thread, taken by the turn that answers a message. It takes hand-overs from
 * the moment it is taken until it closes or releases, which is why nothing can
 * slip between "no turn has this thread" and "this turn has it".
 */
export interface ThreadClaim {
  /**
   * Run `fn` under the thread's mutex, then release the claim. Turns on a thread
   * run one at a time, FIFO, so `fn` may start well after the claim was taken —
   * the inbox has been collecting messages in the meantime.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
  /** Take what is pending, oldest first, or only the messages `which` selects. */
  drain(which?: (message: PendingMessage) => boolean): PendingMessage[];
  /**
   * Take what is pending, or release the claim when nothing is. Synchronous, so
   * the emptiness test and the release are one act: a message cannot arrive
   * between them and be accepted by a claim that is about to end.
   *
   * This is how a turn ends its exchange — an empty result means the thread is
   * free again, and the next message starts a turn of its own.
   */
  drainOrRelease(): PendingMessage[];
  /**
   * Release the claim now and hand back what no turn took, for an exchange that
   * ends by a cancel or a throw. The messages stay in history, unanswered.
   * Returns nothing once the claim has ended.
   */
  end(): PendingMessage[];
  /**
   * Stop taking hand-overs, for an exchange that was cancelled and is still
   * unwinding. The next message takes the thread and gets a turn of its own,
   * which runs once this one leaves the mutex. What was handed over before
   * stays with this claim until it ends.
   */
  close(): void;
}

/** Log a warning past this many pending messages — a sign of a stuck turn. */
const PENDING_WARN_THRESHOLD = 20;

class ThreadTurnService {
  private threads = new Map<string, ThreadState>();

  /**
   * Take the thread for a turn about to answer `message`, or hand `message` to
   * the turn that already has it.
   *
   * Returns the claim when this caller owns the turn, or `null` when the message
   * was handed over — the caller then stores it (it is real history) and does
   * not invoke the model. Synchronous by design: the decision and the hand-over
   * are one act, so two messages arriving in the same tick cannot both conclude
   * the thread is free.
   *
   * Takes the `PendingMessage` rather than its parts so a caller whose own work
   * fails afterwards can name it again and `withdraw()` it.
   */
  claimOrOffer(threadId: string, message: PendingMessage): ThreadClaim | null {
    const state = this.stateFor(threadId);
    if (state.accepting) {
      this.push(threadId, state.accepting, message);
      return null;
    }

    return this.claimFor(threadId, state);
  }

  /**
   * Take the thread once no claim takes hand-overs on it. A claim that closes or
   * releases passes straight to the first caller waiting here, so no message can
   * take the thread between them. For an exchange that must not be handed to another turn.
   */
  claimWhenFree(threadId: string): Promise<ThreadClaim> {
    const state = this.stateFor(threadId);
    if (!state.accepting) return Promise.resolve(this.claimFor(threadId, state));
    return new Promise((resolve) => state.queued.push(resolve));
  }

  /**
   * Hand `message` to the turn that owns `threadId`, without ever taking the
   * thread.
   *
   * Returns false when no turn owns it, which tells the caller the message is
   * theirs to deal with — for transports that keep their own queue (the WS
   * gateway) and fall back to it.
   */
  offer(threadId: string, message: PendingMessage): boolean {
    const inbox = this.threads.get(threadId)?.accepting;
    if (!inbox) return false;

    this.push(threadId, inbox, message);
    return true;
  }

  /**
   * Take back a message handed to the owning turn, if that turn has not drained
   * it yet. Returns false when it is already gone — the model has seen it, and no
   * bookkeeping here can undo that.
   *
   * For the caller whose own follow-up work failed: a hand-over happens *before*
   * the message is stored (the decision has to be one synchronous act), so a
   * failed write would otherwise leave the running turn answering text that never
   * became history.
   */
  withdraw(threadId: string, message: PendingMessage): boolean {
    const inbox = [...(this.threads.get(threadId)?.open ?? [])].find((open) => open.includes(message));
    if (!inbox) return false;

    inbox.splice(inbox.indexOf(message), 1);
    return true;
  }

  /**
   * Run `fn` under the thread's mutex without claiming the thread: exclusive,
   * but not steerable. For turns a user message must not redirect (the goal
   * loop) — a chat turn goes through `claimOrOffer()` instead.
   */
  run<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    return this.withMutex(threadId, fn);
  }

  /** True while a turn takes hand-overs on the thread (logs/tests). */
  isClaimed(threadId: string): boolean {
    return Boolean(this.threads.get(threadId)?.accepting);
  }

  /** How many messages are waiting on the turns that hold claims on the thread (logs/tests). */
  pendingCount(threadId: string): number {
    return [...(this.threads.get(threadId)?.open ?? [])].reduce((sum, inbox) => sum + inbox.length, 0);
  }

  /**
   * Whether the thread still holds any state. Only an idle thread should be
   * untracked, so this is how tests pin that nothing outlives its turn.
   */
  isTracked(threadId: string): boolean {
    return this.threads.has(threadId);
  }

  /**
   * Whether any thread is mid-exchange — a turn running or queued on the
   * mutex, a claim still open between turns, or a follow-up waiting in an
   * inbox. `forget()` drops a thread's entry as soon as all three are clear,
   * so a tracked thread is exactly a busy one.
   */
  hasLiveExchange(): boolean {
    return this.threads.size > 0;
  }

  private async withMutex<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const state = this.stateFor(threadId);
    state.refs += 1;

    // Claim our place in the queue synchronously, before any await, so
    // concurrent callers can't both chain onto the same predecessor.
    const predecessor = state.tail;
    let release!: () => void;
    state.tail = new Promise<void>((resolve) => {
      release = resolve;
    });

    try {
      await predecessor;
      return await fn();
    } finally {
      release();
      state.refs -= 1;
      this.forget(threadId, state);
    }
  }

  private claimFor(threadId: string, state: ThreadState): ThreadClaim {
    const inbox: Inbox = [];
    state.accepting = inbox;
    state.open.add(inbox);
    let open = true;

    // A claim that stops taking hand-overs passes the thread to the first caller
    // waiting for it, in the same act, so no message can take it between them.
    const close = () => {
      if (state.accepting !== inbox) return;
      state.accepting = null;
      const next = state.queued.shift();
      if (next) next(this.claimFor(threadId, state));
    };

    const release = (): PendingMessage[] => {
      if (!open) return [];
      open = false;
      close();
      state.open.delete(inbox);
      // Nothing pending outlives the turn that could have answered it. A turn
      // ends its exchange through `drainOrRelease()`, which only releases on an
      // empty inbox — so anything here belongs to a turn that ended some other
      // way: a cancel, or a throw. The messages are stored either way, so they
      // stay in history for the next turn to read; keeping the pending copy
      // would instead hand that turn text it has already seen.
      const abandoned = inbox.splice(0);
      if (abandoned.length > 0) {
        logger.info(
          'Thread %s released with %d message(s) no turn took; they stay in history',
          threadId,
          abandoned.length,
        );
      }
      this.forget(threadId, state);
      return abandoned;
    };

    const check = (method: string) => {
      if (!open) {
        throw new Error(`ThreadClaim.${method}() used after the claim on thread ${threadId} ended`);
      }
    };

    return {
      // Not `async`: a misused claim must throw at the call site, like the other
      // two, rather than as a rejected promise.
      run: (fn) => {
        check('run');
        return this.withMutex(threadId, fn).finally(() => {
          release();
        });
      },
      drain: (which) => {
        check('drain');
        if (!which) return inbox.splice(0);
        const taken: PendingMessage[] = [];
        const kept: PendingMessage[] = [];
        for (const message of inbox) (which(message) ? taken : kept).push(message);
        inbox.splice(0, inbox.length, ...kept);
        return taken;
      },
      drainOrRelease: () => {
        check('drainOrRelease');
        if (inbox.length === 0) {
          release();
          return [];
        }
        return inbox.splice(0);
      },
      end: release,
      close: () => {
        if (open) close();
      },
    };
  }

  private push(threadId: string, inbox: Inbox, message: PendingMessage): void {
    inbox.push(message);

    if (inbox.length === PENDING_WARN_THRESHOLD) {
      logger.warn(
        'Thread %s has %d messages waiting on the turn that owns it — the turn may be stuck',
        threadId,
        inbox.length,
      );
    }
  }

  private stateFor(threadId: string): ThreadState {
    let state = this.threads.get(threadId);
    if (!state) {
      state = { tail: Promise.resolve(), refs: 0, accepting: null, open: new Set(), queued: [] };
      this.threads.set(threadId, state);
    }
    return state;
  }

  /**
   * Drop a thread's entry once nothing references it, so the map doesn't grow
   * one permanent entry per thread for the process lifetime. An open claim keeps
   * the entry, which is what lets a claim outlive the mutex acquisition it wraps.
   */
  private forget(threadId: string, state: ThreadState): void {
    if (state.refs === 0 && state.open.size === 0) {
      this.threads.delete(threadId);
    }
  }
}

export const threadTurnService = new ThreadTurnService();
