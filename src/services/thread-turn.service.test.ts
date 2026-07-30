/**
 * Thread Turn Service Tests
 *
 * Two invariants: turns on a thread run one at a time (FIFO), and a message that
 * arrives while a turn owns the thread is handed to that turn rather than used to
 * start a second one — from the instant the turn claims the thread, not from the
 * later instant it starts invoking the model, and with nothing silently dropped
 * between a turn ending and its follow-up.
 */

import { describe, it, expect } from 'vitest';
import { threadTurnService, type PendingMessage } from './thread-turn.service';

/** Resolves once the caller signals; lets a test hold a turn open. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A pending message, the shape the primitive now takes and can withdraw. */
const msg = (text: string, attachmentIds: string[] = []): PendingMessage => ({
  text,
  attachmentIds,
});

let seq = 0;
const nextThread = () => `thread-${++seq}`;

/** Claim a thread, failing the test if it was already taken. */
function claim(thread: string, text = 'take the thread') {
  const claimed = threadTurnService.claimOrOffer(thread, msg(text));
  if (!claimed) throw new Error(`expected thread ${thread} to be free`);
  return claimed;
}

describe('threadTurnService', () => {
  describe('exclusivity', () => {
    it('serializes turns on the same thread, FIFO', async () => {
      const thread = nextThread();
      const order: string[] = [];
      const first = deferred();

      const a = threadTurnService.run(thread, async () => {
        order.push('a:start');
        await first.promise;
        order.push('a:end');
      });
      const b = threadTurnService.run(thread, async () => {
        order.push('b:start');
      });

      // b must not have started while a holds the thread.
      await Promise.resolve();
      expect(order).toEqual(['a:start']);

      first.resolve();
      await Promise.all([a, b]);
      expect(order).toEqual(['a:start', 'a:end', 'b:start']);
    });

    it('runs turns on different threads concurrently', async () => {
      const one = nextThread();
      const two = nextThread();
      const held = deferred();
      let secondRan = false;

      const a = threadTurnService.run(one, () => held.promise);
      await threadTurnService.run(two, async () => {
        secondRan = true;
      });

      expect(secondRan).toBe(true);
      held.resolve();
      await a;
    });

    it('does not let a thrown turn poison the next waiter', async () => {
      const thread = nextThread();
      const boom = threadTurnService.run(thread, async () => {
        throw new Error('turn blew up');
      });
      const after = threadTurnService.run(thread, async () => 'ran anyway');

      await expect(boom).rejects.toThrow('turn blew up');
      await expect(after).resolves.toBe('ran anyway');
    });

    it('releases the thread once the turn returns', async () => {
      const thread = nextThread();
      await threadTurnService.run(thread, async () => undefined);
      await expect(threadTurnService.run(thread, async () => 'free')).resolves.toBe('free');
    });

    it('serializes a claimed turn against a plain one', async () => {
      const thread = nextThread();
      const order: string[] = [];
      const goal = deferred();

      const goalTurn = threadTurnService.run(thread, async () => {
        order.push('goal:start');
        await goal.promise;
        order.push('goal:end');
      });
      const chatTurn = claim(thread).run(async () => {
        order.push('chat:start');
      });

      await Promise.resolve();
      expect(order).toEqual(['goal:start']);

      goal.resolve();
      await Promise.all([goalTurn, chatTurn]);
      expect(order).toEqual(['goal:start', 'goal:end', 'chat:start']);
    });
  });

  describe('claimOrOffer', () => {
    it('takes a free thread', () => {
      const thread = nextThread();
      const taken = claim(thread);

      expect(threadTurnService.isClaimed(thread)).toBe(true);
      // Our own message is the turn's prompt, not something to hand over.
      expect(threadTurnService.pendingCount(thread)).toBe(0);

      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('hands the message over the instant the thread is claimed', () => {
      // The window this closes: the owner has not stored its message, taken the
      // mutex, or invoked the model yet. A message arriving now must reach it
      // anyway — otherwise it starts a turn of its own, and by the time that turn
      // runs, history ends on the first turn's replies, which the provider
      // rejects as assistant prefill.
      const thread = nextThread();
      const taken = claim(thread, 'review the PR');

      expect(threadTurnService.claimOrOffer(thread, msg('no need to run tests'))).toBeNull();
      expect(taken.drain()).toEqual([{ text: 'no need to run tests', attachmentIds: [] }]);

      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('carries the handed-over message\'s attachment ids', () => {
      // Ids, not bytes: the decision is synchronous, so the consumer loads them.
      const thread = nextThread();
      const taken = claim(thread);

      threadTurnService.claimOrOffer(thread, msg('look at this log', ['att-1', 'att-2']));

      expect(taken.drain()).toEqual([
        { text: 'look at this log', attachmentIds: ['att-1', 'att-2'] },
      ]);
      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('takes the thread again once the claim ended', () => {
      const thread = nextThread();
      claim(thread).drainOrRelease();

      expect(threadTurnService.claimOrOffer(thread, msg('a turn of my own'))).not.toBeNull();
    });

    it('collects messages while the claiming turn waits for the mutex', async () => {
      // A goal turn holds the thread, so the chat turn cannot start yet. It has
      // claimed the thread, so messages arriving in the meantime are still its
      // to answer — it drains them on its first step.
      const thread = nextThread();
      const goal = deferred();
      const goalTurn = threadTurnService.run(thread, () => goal.promise);

      const taken = claim(thread, 'first');
      expect(threadTurnService.claimOrOffer(thread, msg('while queued'))).toBeNull();

      let seen: PendingMessage[] = [];
      const chatTurn = taken.run(async () => {
        seen = taken.drain();
      });

      goal.resolve();
      await Promise.all([goalTurn, chatTurn]);
      expect(seen).toEqual([{ text: 'while queued', attachmentIds: [] }]);
    });
  });

  describe('offer', () => {
    it('rejects an offer when no turn owns the thread', () => {
      const thread = nextThread();
      expect(threadTurnService.offer(thread, msg('hello'))).toBe(false);
      expect(threadTurnService.pendingCount(thread)).toBe(0);
    });

    it('never takes the thread, so a rejected offer leaves it free', () => {
      // What steer-only callers rely on: a probe stores nothing and claims
      // nothing, so the message stays theirs to queue.
      const thread = nextThread();

      expect(threadTurnService.offer(thread, msg('probe'))).toBe(false);

      expect(threadTurnService.isClaimed(thread)).toBe(false);
      expect(threadTurnService.isTracked(thread)).toBe(false);
    });

    it('accepts an offer while a turn owns the thread', () => {
      const thread = nextThread();
      const taken = claim(thread);

      expect(threadTurnService.offer(thread, msg('skip the tests'))).toBe(true);
      expect(threadTurnService.pendingCount(thread)).toBe(1);

      expect(taken.drainOrRelease()).toEqual([
        { text: 'skip the tests', attachmentIds: [] },
      ]);
    });

    it('only accepts offers for the thread that is claimed', () => {
      const thread = nextThread();
      const other = nextThread();
      const taken = claim(thread);

      expect(threadTurnService.offer(other, msg('other thread'))).toBe(false);

      expect(taken.drainOrRelease()).toEqual([]);
    });
  });

  describe('withdraw', () => {
    it('takes back a message the owning turn has not drained', () => {
      // A hand-over lands in the inbox before the caller has stored the message —
      // it must, for the decision to be one act. If that store then fails, the
      // text has to come back out, or the turn answers something that never
      // became history.
      const thread = nextThread();
      const taken = claim(thread);
      const handed = msg('never made it to the database');
      threadTurnService.offer(thread, handed);

      expect(threadTurnService.withdraw(thread, handed)).toBe(true);
      expect(threadTurnService.pendingCount(thread)).toBe(0);
      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('leaves the other pending messages alone', () => {
      const thread = nextThread();
      const taken = claim(thread);
      const first = msg('keep me');
      const doomed = msg('withdraw me');
      const last = msg('keep me too');
      threadTurnService.offer(thread, first);
      threadTurnService.offer(thread, doomed);
      threadTurnService.offer(thread, last);

      expect(threadTurnService.withdraw(thread, doomed)).toBe(true);

      expect(taken.drainOrRelease()).toEqual([first, last]);
    });

    it('reports false once the turn has taken the message', () => {
      // Best effort by nature: after a drain the model has seen it, and nothing
      // here can undo that. The caller logs it rather than pretending otherwise.
      const thread = nextThread();
      const taken = claim(thread);
      const handed = msg('already injected');
      threadTurnService.offer(thread, handed);
      taken.drain();

      expect(threadTurnService.withdraw(thread, handed)).toBe(false);
    });

    it('reports false for an untracked thread', () => {
      expect(threadTurnService.withdraw(nextThread(), msg('nothing here'))).toBe(false);
    });
  });

  describe('drain', () => {
    it('hands over pending messages in arrival order', () => {
      const thread = nextThread();
      const taken = claim(thread);

      threadTurnService.offer(thread, msg('first'));
      threadTurnService.offer(thread, msg('second'));

      expect(taken.drain()).toEqual([
        { text: 'first', attachmentIds: [] },
        { text: 'second', attachmentIds: [] },
      ]);
      expect(threadTurnService.pendingCount(thread)).toBe(0);

      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('keeps the claim, so a drained turn still owns the thread', () => {
      const thread = nextThread();
      const taken = claim(thread);

      threadTurnService.offer(thread, msg('mid-turn'));
      taken.drain();

      // The turn is between steps, not finished: the next message is still its.
      expect(threadTurnService.isClaimed(thread)).toBe(true);
      expect(threadTurnService.offer(thread, msg('and another'))).toBe(true);

      expect(taken.drainOrRelease()).toEqual([{ text: 'and another', attachmentIds: [] }]);
    });
  });

  describe('drainOrRelease', () => {
    it('returns what is pending and keeps the thread', () => {
      const thread = nextThread();
      const taken = claim(thread);
      threadTurnService.offer(thread, msg('landed at the very end'));

      // Retrievable after the last step, so the coalesced follow-up answers it
      // rather than the message being dropped.
      expect(taken.drainOrRelease()).toEqual([
        { text: 'landed at the very end', attachmentIds: [] },
      ]);
      expect(threadTurnService.isClaimed(thread)).toBe(true);

      expect(taken.drainOrRelease()).toEqual([]);
    });

    it('releases the thread when nothing is pending', () => {
      // The release and the emptiness test are one synchronous act, so no message
      // can be handed to a claim that is about to end.
      const thread = nextThread();
      const taken = claim(thread);

      expect(taken.drainOrRelease()).toEqual([]);

      expect(threadTurnService.isClaimed(thread)).toBe(false);
      expect(threadTurnService.offer(thread, msg('too late'))).toBe(false);
      expect(threadTurnService.isTracked(thread)).toBe(false);
    });
  });

  describe('release', () => {
    it('releases the claim when the turn returns', async () => {
      const thread = nextThread();
      const taken = claim(thread);

      await taken.run(async () => {
        expect(threadTurnService.isClaimed(thread)).toBe(true);
      });

      expect(threadTurnService.isClaimed(thread)).toBe(false);
      expect(threadTurnService.isTracked(thread)).toBe(false);
    });

    it('clears messages the turn never drained', async () => {
      // The invariant lives here, not in caller convention: a turn that ends
      // without draining (a cancel, a throw, or a caller that simply forgot) must
      // not leave its inbox for the next turn on the thread. The messages are
      // stored, so history carries them; replaying the pending copy would hand a
      // later turn text it has already read.
      const thread = nextThread();
      const taken = claim(thread);

      await taken.run(async () => {
        threadTurnService.offer(thread, msg('never taken'));
      });

      expect(threadTurnService.pendingCount(thread)).toBe(0);
      expect(threadTurnService.isTracked(thread)).toBe(false);
    });

    it('clears leftovers when the turn throws', async () => {
      const thread = nextThread();
      const taken = claim(thread);

      await expect(
        taken.run(async () => {
          threadTurnService.offer(thread, msg('orphaned by the throw'));
          throw new Error('invoke blew up');
        }),
      ).rejects.toThrow('invoke blew up');

      expect(threadTurnService.isClaimed(thread)).toBe(false);
      expect(threadTurnService.pendingCount(thread)).toBe(0);
    });

    it('does not hand one turn\'s leftovers to the next turn', async () => {
      const thread = nextThread();
      const first = claim(thread);
      await first.run(async () => {
        threadTurnService.offer(thread, msg('from the first turn'));
      });

      const second = claim(thread);
      const seen = await second.run(async () => second.drain());

      expect(seen).toEqual([]);
    });
  });

  describe('claim scoping', () => {
    it('rejects a claim used after it ended', async () => {
      // The claim is the only route to the inbox, and it dies with the exchange —
      // so a stashed claim cannot collect messages for a thread that has moved on
      // to another turn.
      const thread = nextThread();
      const taken = claim(thread);
      await taken.run(async () => undefined);

      expect(() => taken.drain()).toThrow(/after the claim on thread .* ended/);
      expect(() => taken.drainOrRelease()).toThrow(/after the claim on thread .* ended/);
      expect(() => taken.run(async () => undefined)).toThrow(/after the claim on thread .* ended/);
      expect(threadTurnService.isClaimed(thread)).toBe(false);
    });
  });
});
