import { describe, it, expect } from 'vitest';
import { AsyncChannel } from './async-channel';

describe('AsyncChannel', () => {
  it('yields values pushed before iteration', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.push(2);
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([1, 2]);
  });

  it('yields values pushed during iteration', async () => {
    const ch = new AsyncChannel<string>();
    const values: string[] = [];

    const consumer = (async () => {
      for await (const v of ch) {
        values.push(v);
      }
    })();

    ch.push('a');
    ch.push('b');
    // Allow microtasks to process
    await Promise.resolve();
    ch.push('c');
    ch.close();

    await consumer;
    expect(values).toEqual(['a', 'b', 'c']);
  });

  it('returns immediately when closed with no values', async () => {
    const ch = new AsyncChannel<number>();
    ch.close();

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([]);
  });

  it('throws the error set via error()', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.error(new Error('boom'));

    const values: number[] = [];
    await expect(async () => {
      for await (const v of ch) {
        values.push(v);
      }
    }).rejects.toThrow('boom');

    // Should have yielded the value pushed before the error
    expect(values).toEqual([1]);
  });

  it('throws when error() is called while consumer is waiting', async () => {
    const ch = new AsyncChannel<number>();

    const promise = (async () => {
      const values: number[] = [];
      for await (const v of ch) {
        values.push(v);
      }
      return values;
    })();

    // Let consumer start waiting
    await Promise.resolve();
    ch.error(new Error('failed'));

    await expect(promise).rejects.toThrow('failed');
  });

  it('ignores pushes after close', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.close();
    ch.push(2);

    const values: number[] = [];
    for await (const v of ch) {
      values.push(v);
    }
    expect(values).toEqual([1]);
  });

  it('ignores pushes after error', async () => {
    const ch = new AsyncChannel<number>();
    ch.push(1);
    ch.error(new Error('err'));
    ch.push(2);

    const values: number[] = [];
    try {
      for await (const v of ch) {
        values.push(v);
      }
    } catch {
      // expected
    }
    expect(values).toEqual([1]);
  });

  it('works with yield* delegation', async () => {
    const ch = new AsyncChannel<number>();

    async function* gen() {
      yield* ch;
    }

    const consumer = (async () => {
      const values: number[] = [];
      for await (const v of gen()) {
        values.push(v);
      }
      return values;
    })();

    ch.push(10);
    ch.push(20);
    await Promise.resolve();
    ch.close();

    expect(await consumer).toEqual([10, 20]);
  });

  it('handles interleaved push and consume', async () => {
    const ch = new AsyncChannel<number>();
    const values: number[] = [];

    const consumer = (async () => {
      for await (const v of ch) {
        values.push(v);
      }
    })();

    for (let i = 0; i < 5; i++) {
      ch.push(i);
      await Promise.resolve();
    }
    ch.close();

    await consumer;
    expect(values).toEqual([0, 1, 2, 3, 4]);
  });
});
