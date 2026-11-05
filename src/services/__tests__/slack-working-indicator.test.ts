/**
 * Tests for the Slack working indicator: refcounted assistant-thread status
 * entries (the primary cue), the eyes-reaction fallback (added only when the
 * initial status set fails, or right away for turns without a status thread),
 * event-driven status pushes (set on begin, on text change, and after bot
 * posts — all skipped once the initial set failed), and ordered clears. Ops are plain vi.fn()s — a resolving setStatus
 * is the success regime, a rejecting one drives the fallback; fake timers
 * only flush microtasks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { logger } from '../../logger';
import {
  SlackWorkingIndicator,
  WORKING_REACTION,
  WORKING_STATUS_TEXT,
  createToolStatusListener,
  toolStatusText,
} from '../slack-working-indicator';

const TEAM = 'T001';
const CHANNEL = 'C001';
const MSG_TS = '1111.0001';
const THREAD_TS = '1111.0000';

function makeOps() {
  return {
    addReaction: vi.fn().mockResolvedValue(undefined),
    removeReaction: vi.fn().mockResolvedValue(undefined),
    setStatus: vi.fn().mockResolvedValue(undefined),
  };
}

describe('SlackWorkingIndicator', () => {
  let ops: ReturnType<typeof makeOps>;
  let indicator: SlackWorkingIndicator;

  beforeEach(() => {
    vi.useFakeTimers();
    ops = makeOps();
    indicator = new SlackWorkingIndicator(ops);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('begin with a status thread sets the initial status and suppresses the reaction', async () => {
    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0); // let the fallback decision resolve

    expect(ops.setStatus).toHaveBeenCalledExactlyOnceWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);
    expect(ops.addReaction).not.toHaveBeenCalled();
  });

  it('falls back to the reaction when the initial status set fails', async () => {
    ops.setStatus.mockRejectedValueOnce(new Error('not an AI app'));

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0); // let the fallback decision resolve

    // The add waits for the set's outcome, so it always trails the attempt.
    expect(ops.addReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
    expect(ops.addReaction.mock.invocationCallOrder[0])
      .toBeGreaterThan(ops.setStatus.mock.invocationCallOrder[0]);

    await handle.end();
    expect(ops.removeReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
  });

  it('begin without a status thread (top-level DM) is reaction-only', async () => {
    await indicator.begin({ teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS });

    expect(ops.addReaction).toHaveBeenCalledOnce();
    expect(ops.setStatus).not.toHaveBeenCalled();
  });

  it('begin without a message ts is status-only', async () => {
    await indicator.begin({ teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS });

    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.setStatus).toHaveBeenCalledOnce();
  });

  it('pushes the tool phrase immediately on setText, dedupes repeats, and reverts on null', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);

    handle.setText(toolStatusText(['kubectl']));
    await vi.advanceTimersByTimeAsync(0); // flush the per-key op chain
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, 'is running kubectl…');

    handle.setText(toolStatusText(['kubectl'])); // unchanged text — no extra call
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledTimes(2);

    handle.setText(null);
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);
    expect(ops.setStatus).toHaveBeenCalledTimes(3);
  });

  it('ignores setText after end and without a status thread', async () => {
    const noStatus = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS,
    });
    noStatus.setText('is running kubectl…'); // no status thread — must not throw
    await noStatus.end();
    expect(ops.setStatus).not.toHaveBeenCalled();

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    await handle.end();
    const calls = ops.setStatus.mock.calls.length;
    handle.setText('is running kubectl…'); // after end — no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledTimes(calls);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });

  it('setStatus sets the current status again after a bot post; no-op for idle threads', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    handle.setText(toolStatusText(['kubectl']));

    // A mid-turn bot post cleared the status on Slack's side — setStatus
    // sends whatever text is current.
    indicator.setStatus(TEAM, CHANNEL, THREAD_TS);
    await vi.advanceTimersByTimeAsync(0); // flush the per-key op chain
    expect(ops.setStatus).toHaveBeenCalledTimes(3); // begin + setText + setStatus
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, 'is running kubectl…');

    await handle.end();
    const calls = ops.setStatus.mock.calls.length;
    indicator.setStatus(TEAM, CHANNEL, THREAD_TS); // no live turn — no-op
    indicator.setStatus(TEAM, CHANNEL, '9999.0000'); // unknown thread — no-op
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledTimes(calls);
  });

  it('end clears the status; a second end is a no-op', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });

    await handle.end();

    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
    // The status rendered, so no reaction was ever added — nothing to remove.
    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.removeReaction).not.toHaveBeenCalled();

    await handle.end();
    expect(ops.setStatus).toHaveBeenCalledTimes(2); // no second clear
  });

  it('refcounts the status across two turns on the same thread (steered scenario)', async () => {
    const owning = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    const steered = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: '1111.0002', statusThreadTs: THREAD_TS,
    });

    expect(ops.setStatus).toHaveBeenCalledOnce(); // one entry, one initial set

    await steered.end();
    // Steered end must not clear the shared status the owning turn still needs.
    expect(ops.setStatus).not.toHaveBeenCalledWith(TEAM, CHANNEL, THREAD_TS, '');

    await owning.end();
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
    // The shared status rendered — neither turn added a reaction.
    expect(ops.addReaction).not.toHaveBeenCalled();
  });

  it('shares the failed-status decision across turns on the same thread', async () => {
    ops.setStatus.mockRejectedValue(new Error('not an AI app'));

    const owning = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    const steered = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: '1111.0002', statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0); // let the fallback decisions resolve

    // One initial set decides for both turns; each reacts to its own message.
    expect(ops.setStatus).toHaveBeenCalledOnce();
    expect(ops.addReaction).toHaveBeenCalledTimes(2);
    expect(ops.addReaction).toHaveBeenCalledWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
    expect(ops.addReaction).toHaveBeenCalledWith(CHANNEL, '1111.0002', TEAM, WORKING_REACTION);

    await steered.end();
    expect(ops.removeReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, '1111.0002', TEAM, WORKING_REACTION);

    await owning.end();
    expect(ops.removeReaction).toHaveBeenCalledWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
  });

  it('stops pushing the status once the initial set failed', async () => {
    ops.setStatus.mockRejectedValueOnce(new Error('not an AI app'));

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0); // let the initial outcome land
    expect(ops.setStatus).toHaveBeenCalledOnce(); // the rejected initial set

    // Both push paths: the live tool phrase, and the re-push the adapter fires
    // after every bot post. Neither can restore a cue this thread never had.
    handle.setText('is running kubectl…');
    indicator.setStatus(TEAM, CHANNEL, THREAD_TS);
    indicator.setStatus(TEAM, CHANNEL, THREAD_TS);
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledOnce();

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Slack thread status rejected'),
      WORKING_REACTION, CHANNEL, THREAD_TS,
    );

    // The clear still goes out — the one case a rendered status could stick is
    // a set that failed after Slack had already stored it.
    await handle.end();
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });

  it('tries the status again for the next turn on the same thread', async () => {
    ops.setStatus.mockRejectedValueOnce(new Error('ratelimited'));

    const first = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0);
    await first.end();

    // The failure was cached on that entry, not on the thread: a fresh entry
    // retries, so a transient rejection costs one turn's cue and no more.
    const second = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: '1111.0002', statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);

    second.setText('is running kubectl…');
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, 'is running kubectl…');
    expect(ops.addReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
  });

  it('logs the accepted initial status — the phrase the e2e suite greps', async () => {
    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0);

    // The status line is write-only on the Slack API, so this line is what the
    // Slack e2e suite asserts on. Renaming it there and not here (or the other
    // way round) is the regression this pins.
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Slack thread status accepted'),
      CHANNEL, THREAD_TS,
    );
  });

  it('keeps status entries on different threads independent', async () => {
    const a = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: '2222.0000',
    });
    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: '3333.0000',
    });

    await a.end();

    // Only the ended thread was cleared; the other still sets its status.
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, '2222.0000', '');
    indicator.setStatus(TEAM, CHANNEL, '3333.0000');
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, '3333.0000', WORKING_STATUS_TEXT);
  });

  it('resolves begin and end even when every op rejects — the fallback path', async () => {
    ops.addReaction.mockRejectedValue(new Error('no scope'));
    ops.removeReaction.mockRejectedValue(new Error('no_reaction'));
    ops.setStatus.mockRejectedValue(new Error('not an AI app'));

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    await vi.advanceTimersByTimeAsync(0);
    // Failed set → fallback fires; its own failure is swallowed too.
    expect(ops.addReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);

    await handle.end();
    // The add was attempted, so end still tries the remove.
    expect(ops.removeReaction).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync(); // let swallowed rejections settle
  });

  it('stopAll ends every live handle', async () => {
    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: '1.1', statusThreadTs: '1.0',
    });
    await indicator.begin({
      teamId: TEAM, channelId: 'C002', messageTs: '2.1',
    });

    await indicator.stopAll();

    // Only the status-less handle reacted; the other turn's status rendered.
    expect(ops.removeReaction).toHaveBeenCalledExactlyOnceWith('C002', '2.1', TEAM, WORKING_REACTION);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, '1.0', '');
  });

  it('stopAll during an in-flight reaction add still removes it, in order', async () => {
    let resolveAdd!: () => void;
    ops.addReaction.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveAdd = resolve; }),
    );

    const beginPromise = indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS,
    });
    const stopPromise = indicator.stopAll();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // end() must wait for the in-flight add — remove cannot overtake it.
    expect(ops.removeReaction).not.toHaveBeenCalled();

    resolveAdd();
    await stopPromise;
    await beginPromise;

    expect(ops.removeReaction).toHaveBeenCalledExactlyOnceWith(CHANNEL, MSG_TS, TEAM, WORKING_REACTION);
  });

  it('skips the fallback reaction when the turn ends before the status outcome', async () => {
    let rejectSet!: (error: Error) => void;
    ops.setStatus.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectSet = reject; }),
    );

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    const endPromise = handle.end();
    rejectSet(new Error('not an AI app'));
    await endPromise;

    // The set failed, but the turn had already ended — the cue could never be
    // seen, so no add-then-remove flash.
    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.removeReaction).not.toHaveBeenCalled();
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });

  it('a steered end does not wait for the in-flight status outcome', async () => {
    // The initial set never settles — a stuck Slack call. The steered turn's
    // end() has nothing to clear (the owning turn still holds the entry) and
    // its add is off the table once ended, so it must resolve regardless.
    ops.setStatus.mockImplementationOnce(() => new Promise<void>(() => {}));

    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    const steered = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: '1111.0002', statusThreadTs: THREAD_TS,
    });

    await steered.end();

    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.removeReaction).not.toHaveBeenCalled();
  });

  it('adds no reaction flash when stopAll fires before the status outcome', async () => {
    let rejectSet!: (error: Error) => void;
    ops.setStatus.mockImplementationOnce(
      () => new Promise<void>((_resolve, reject) => { rejectSet = reject; }),
    );

    await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    const stopPromise = indicator.stopAll();
    rejectSet(new Error('not an AI app'));
    await stopPromise;

    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.removeReaction).not.toHaveBeenCalled();
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });

  it('begin after stopAll returns an inert handle', async () => {
    await indicator.stopAll();

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, messageTs: MSG_TS, statusThreadTs: THREAD_TS,
    });
    handle.setText('is running kubectl…');
    await handle.end();

    expect(ops.addReaction).not.toHaveBeenCalled();
    expect(ops.setStatus).not.toHaveBeenCalled();
    expect(ops.removeReaction).not.toHaveBeenCalled();
  });

  it('coalesces text changes made while a status call is in flight into one push of the latest text', async () => {
    let resolveSet!: () => void;
    ops.setStatus.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSet = resolve; }),
    );
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });

    // A program's quick tool calls flip the phrase on every start and end.
    for (let i = 0; i < 500; i++) {
      handle.setText(toolStatusText(['run_program', 'shell_stdout']));
      handle.setText(toolStatusText(['run_program']));
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledTimes(1); // the initial set, still in flight

    resolveSet();
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenCalledTimes(2);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, 'is running run_program…');

    await handle.end();
    expect(ops.setStatus).toHaveBeenCalledTimes(3);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });

  it('drops a queued text push when the turn ends before it starts', async () => {
    let resolveSet!: () => void;
    ops.setStatus.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSet = resolve; }),
    );
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    handle.setText(toolStatusText(['kubectl']));
    const ending = handle.end();
    resolveSet();
    await ending;

    expect(ops.setStatus.mock.calls.map((call) => call[3])).toEqual([WORKING_STATUS_TEXT, '']);
  });

  it('serializes status calls per thread so a clear cannot overtake an in-flight set', async () => {
    let resolveSet!: () => void;
    ops.setStatus.mockImplementationOnce(
      () => new Promise<void>((resolve) => { resolveSet = resolve; }),
    );

    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    const endPromise = handle.end();
    await vi.advanceTimersByTimeAsync(0); // flush microtasks

    // The initial set is still in flight — the clear must queue behind it.
    expect(ops.setStatus).toHaveBeenCalledTimes(1);

    resolveSet();
    await endPromise;

    expect(ops.setStatus).toHaveBeenCalledTimes(2);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, '');
  });
});

describe('toolStatusText', () => {
  it('formats one, two, and three names', () => {
    expect(toolStatusText(['kubectl'])).toBe('is running kubectl…');
    expect(toolStatusText(['kubectl', 'pwd'])).toBe('is running kubectl and pwd…');
    expect(toolStatusText(['x', 'y', 'z'])).toBe('is running x, y and z…');
  });

  it('collapses parallel calls of the same tool into one name', () => {
    expect(toolStatusText(['shell', 'shell'])).toBe('is running shell…');
    expect(toolStatusText(['shell', 'kubectl', 'shell'])).toBe('is running shell and kubectl…');
  });
});

describe('createToolStatusListener', () => {
  let ops: ReturnType<typeof makeOps>;
  let indicator: SlackWorkingIndicator;

  beforeEach(() => {
    vi.useFakeTimers();
    ops = makeOps();
    indicator = new SlackWorkingIndicator(ops);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('lists every running tool and keeps the survivor visible when an overlapping tool finishes', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    const listener = createToolStatusListener(handle);

    // Flush the per-key op chain after each event: changes made while a push
    // waits are coalesced, and this test reads every phrase.
    listener({ type: 'started', toolName: 'kubectl' });
    await vi.advanceTimersByTimeAsync(0);
    listener({ type: 'started', toolName: 'pwd' });
    await vi.advanceTimersByTimeAsync(0);
    listener({ type: 'completed', toolName: 'kubectl' }); // pwd still runs
    await vi.advanceTimersByTimeAsync(0);

    expect(ops.setStatus.mock.calls.map((c) => c[3])).toEqual([
      WORKING_STATUS_TEXT,
      'is running kubectl…',
      'is running kubectl and pwd…',
      'is running pwd…',
    ]);

    listener({ type: 'completed', toolName: 'pwd' }); // none left — default text
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);
  });

  it('tracks two parallel calls of the same tool as a multiset', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    const listener = createToolStatusListener(handle);

    listener({ type: 'started', toolName: 'shell' });
    listener({ type: 'started', toolName: 'shell' }); // same text — deduped push
    listener({ type: 'completed', toolName: 'shell' }); // one still runs — text unchanged
    await vi.advanceTimersByTimeAsync(0);

    expect(ops.setStatus.mock.calls.map((c) => c[3])).toEqual([
      WORKING_STATUS_TEXT,
      'is running shell…',
    ]);

    listener({ type: 'completed', toolName: 'shell' }); // last one — default text
    await vi.advanceTimersByTimeAsync(0);
    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, WORKING_STATUS_TEXT);
  });

  it('ignores a completed event with no matching start', async () => {
    const handle = await indicator.begin({
      teamId: TEAM, channelId: CHANNEL, statusThreadTs: THREAD_TS,
    });
    const listener = createToolStatusListener(handle);

    listener({ type: 'completed', toolName: 'kubectl' }); // stray — must not throw
    listener({ type: 'started', toolName: 'pwd' });
    await vi.advanceTimersByTimeAsync(0);

    expect(ops.setStatus).toHaveBeenLastCalledWith(TEAM, CHANNEL, THREAD_TS, 'is running pwd…');
  });
});
