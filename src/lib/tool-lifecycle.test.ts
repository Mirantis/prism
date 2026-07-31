/**
 * Tests for the tool lifecycle wrapper: started/completed events fire around
 * execute() (completed even on throw), listener errors are swallowed, and
 * tools are otherwise untouched.
 */
import { describe, it, expect, vi } from 'vitest';
import type { Tool } from 'ai';

import { withToolLifecycleEvents, ToolLifecycleEvent } from './tool-lifecycle';

function makeTool(execute?: (args: unknown, options: unknown) => Promise<unknown>): Tool {
  return { description: 'a tool', inputSchema: { type: 'object' }, execute } as unknown as Tool;
}

describe('withToolLifecycleEvents', () => {
  it('returns the tools untouched without a listener', () => {
    const tools = { kubectl: makeTool(async () => 'ok') };
    expect(withToolLifecycleEvents(tools, undefined)).toBe(tools);
  });

  it('fires started before execute and completed after, preserving the result', async () => {
    const events: ToolLifecycleEvent[] = [];
    const order: string[] = [];
    const tools = {
      kubectl: makeTool(async () => {
        order.push('execute');
        return 'result';
      }),
    };

    const wrapped = withToolLifecycleEvents(tools, (e) => {
      events.push(e);
      order.push(e.type);
    });
    const result = await wrapped.kubectl.execute!({ ns: 'default' } as never, {} as never);

    expect(result).toBe('result');
    expect(order).toEqual(['started', 'execute', 'completed']);
    expect(events).toEqual([
      { type: 'started', toolName: 'kubectl' },
      { type: 'completed', toolName: 'kubectl' },
    ]);
  });

  it('fires completed even when the tool throws, and rethrows the error', async () => {
    const events: ToolLifecycleEvent[] = [];
    const tools = {
      broken: makeTool(async () => {
        throw new Error('tool exploded');
      }),
    };

    const wrapped = withToolLifecycleEvents(tools, (e) => events.push(e));

    await expect(wrapped.broken.execute!({} as never, {} as never)).rejects.toThrow('tool exploded');
    expect(events.map((e) => e.type)).toEqual(['started', 'completed']);
  });

  it('swallows listener errors so the tool call is unaffected', async () => {
    const tools = { kubectl: makeTool(async () => 'ok') };
    const wrapped = withToolLifecycleEvents(tools, () => {
      throw new Error('listener bug');
    });

    await expect(wrapped.kubectl.execute!({} as never, {} as never)).resolves.toBe('ok');
  });

  it('leaves tools without execute untouched', () => {
    const tool = makeTool(undefined);
    const wrapped = withToolLifecycleEvents({ passive: tool }, vi.fn());
    expect(wrapped.passive).toBe(tool);
  });
});
