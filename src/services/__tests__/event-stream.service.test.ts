import { describe, it, expect } from 'vitest';
import { EventStreamService } from '../event-stream.service';

const turn = (threadId: string) =>
  ({ type: 'turn', payload: { threadId, state: 'running' } }) as const;

describe('EventStreamService', () => {
  it('numbers events in order and hands each to every subscriber once', () => {
    const stream = new EventStreamService();
    const seen: number[] = [];
    stream.subscribe((entry) => seen.push(entry.seq));

    stream.publish(turn('a'));
    stream.publish(turn('b'));

    expect(seen).toEqual([1, 2]);
    expect(stream.seq).toBe(2);
  });

  it('sends the frame with its seq, serialized once', () => {
    const stream = new EventStreamService();
    const entry = stream.publish(turn('a'));
    expect(JSON.parse(entry.frame)).toEqual({ type: 'turn', seq: 1, payload: { threadId: 'a', state: 'running' } });
  });

  it('replays what a client missed, in order', () => {
    const stream = new EventStreamService();
    stream.publish(turn('a'));
    stream.publish(turn('b'));
    stream.publish(turn('c'));

    expect(stream.replayAfter(stream.streamId, 1)?.map((e) => e.seq)).toEqual([2, 3]);
    expect(stream.replayAfter(stream.streamId, 3)).toEqual([]);
  });

  it('refuses a cursor from another process', () => {
    const stream = new EventStreamService();
    stream.publish(turn('a'));
    expect(stream.replayAfter('some-other-stream', 0)).toBeNull();
  });

  it('refuses a cursor ahead of the stream', () => {
    const stream = new EventStreamService();
    stream.publish(turn('a'));
    expect(stream.replayAfter(stream.streamId, 5)).toBeNull();
  });

  it('refuses a gap it no longer holds', () => {
    const stream = new EventStreamService({ maxEvents: 2, maxBytes: 1e9, maxGapBytes: 1e9 });
    stream.publish(turn('a'));
    stream.publish(turn('b'));
    stream.publish(turn('c'));

    // Event 1 was evicted, so a client that stopped at 0 cannot be caught up.
    expect(stream.replayAfter(stream.streamId, 0)).toBeNull();
    expect(stream.replayAfter(stream.streamId, 1)?.map((e) => e.seq)).toEqual([2, 3]);
  });

  it('evicts by bytes as well as by count', () => {
    const stream = new EventStreamService({ maxEvents: 100, maxBytes: 150, maxGapBytes: 1e9 });
    for (const id of ['a', 'b', 'c', 'd']) stream.publish(turn(id));
    expect(stream.replayAfter(stream.streamId, 0)).toBeNull();
    expect(stream.replayAfter(stream.streamId, 3)?.map((e) => e.seq)).toEqual([4]);
  });

  it('answers a replay too large for one resume with a reload', () => {
    const stream = new EventStreamService({ maxEvents: 100, maxBytes: 1e9, maxGapBytes: 150 });
    for (const id of ['a', 'b', 'c', 'd']) stream.publish(turn(id));
    expect(stream.replayAfter(stream.streamId, 0)).toBeNull();
    expect(stream.replayAfter(stream.streamId, 3)?.map((e) => e.seq)).toEqual([4]);
  });

  it('stops handing events to a subscriber that left', () => {
    const stream = new EventStreamService();
    const seen: number[] = [];
    const stop = stream.subscribe((entry) => seen.push(entry.seq));
    stream.publish(turn('a'));
    stop();
    stream.publish(turn('b'));
    expect(seen).toEqual([1]);
  });
});
