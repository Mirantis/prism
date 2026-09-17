import { describe, it, expect, afterEach } from 'vitest';
import { inferenceGate } from './inference-gate';

afterEach(() => inferenceGate.free());

describe('the inference gate', () => {
  it('lets a call through while nothing holds it', async () => {
    await expect(inferenceGate.wait()).resolves.toBeUndefined();
  });

  it('holds a call until the window closes', async () => {
    inferenceGate.hold();
    let through = false;
    const call = inferenceGate.wait().then(() => {
      through = true;
    });
    await Promise.resolve();
    expect(through).toBe(false);

    inferenceGate.free();
    await call;
    expect(through).toBe(true);
  });

  it('holds once, however many times it is asked', async () => {
    inferenceGate.hold();
    inferenceGate.hold();
    const call = inferenceGate.wait();
    inferenceGate.free();
    await expect(call).resolves.toBeUndefined();
    expect(inferenceGate.held).toBe(false);
  });

  it('lets an aborted caller through while nothing holds it', async () => {
    const controller = new AbortController();
    controller.abort(new Error('turn canceled'));

    await expect(inferenceGate.wait(controller.signal)).resolves.toBeUndefined();
  });

  it('gives up on a caller that aborts while it waits', async () => {
    inferenceGate.hold();
    const controller = new AbortController();
    const call = inferenceGate.wait(controller.signal);
    controller.abort(new Error('turn canceled'));
    await expect(call).rejects.toThrow('turn canceled');
  });
});
