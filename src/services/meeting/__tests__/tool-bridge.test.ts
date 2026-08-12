import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';

const mockCollectTools = vi.fn();
vi.mock('../../../lib/tool-collection', () => ({
  collectTools: (...args: unknown[]) => mockCollectTools(...args),
}));

const { prepareMeetingTools } = await import('../tool-bridge');

beforeEach(() => {
  mockCollectTools.mockReset();
});

describe('prepareMeetingTools', () => {
  it('collects tools in meeting mode with no workspace', async () => {
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });

    await prepareMeetingTools({ userId: 'u1', agentId: 'a1', threadId: 't1' });

    expect(mockCollectTools).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', agentId: 'a1', threadId: 't1', mode: 'meeting', workspaceRoot: undefined }),
    );
  });

  it('converts a zod tool schema to JSON Schema the Realtime API can read', async () => {
    mockCollectTools.mockResolvedValue({
      tools: {
        list_scheduled_tasks: tool({
          description: 'List all scheduled tasks.',
          inputSchema: z.object({ limit: z.number().describe('How many') }),
          execute: async () => ({ tasks: [] }),
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(prepared.count).toBe(1);
    expect(prepared.declarations[0]).toMatchObject({
      name: 'list_scheduled_tasks',
      description: 'List all scheduled tasks.',
      parameters: expect.objectContaining({
        type: 'object',
        properties: expect.objectContaining({ limit: expect.objectContaining({ type: 'number' }) }),
      }),
    });
  });

  it('passes through a pre-wrapped JSON Schema tool (as MCP tools arrive)', async () => {
    mockCollectTools.mockResolvedValue({
      tools: {
        kubectl_get: tool({
          description: 'Run kubectl get',
          inputSchema: jsonSchema({ type: 'object', properties: { resource: { type: 'string' } } }),
          execute: async () => 'ok',
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(prepared.declarations[0].parameters).toMatchObject({
      type: 'object',
      properties: { resource: { type: 'string' } },
    });
  });

  it('offers every executable tool, Task included', async () => {
    // Long-running tools all hand back a handle immediately rather than blocking,
    // so the model can start work, say so, and report back later in the same call.
    mockCollectTools.mockResolvedValue({
      tools: {
        Task: tool({ description: 'Delegate', inputSchema: z.object({}), execute: async () => 'x' }),
        memory_search: tool({ description: 'Search', inputSchema: z.object({}), execute: async () => 'y' }),
      },
      subagents: [{ name: 'helper', description: 'A helper' }],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(prepared.declarations.map((d) => d.name).sort()).toEqual(['Task', 'memory_search']);
  });

  it('drops tools with no local implementation to call', async () => {
    mockCollectTools.mockResolvedValue({
      tools: {
        // No execute — a provider-executed tool the bridge could not answer.
        provider_side: { description: 'Runs elsewhere', inputSchema: z.object({}) },
        real: tool({ description: 'Real', inputSchema: z.object({}), execute: async () => 'ok' }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(prepared.declarations.map((d) => d.name)).toEqual(['real']);
  });

  it('executes a tool and returns its result as text', async () => {
    const execute = vi.fn().mockResolvedValue({ count: 2, tasks: ['a', 'b'] });
    mockCollectTools.mockResolvedValue({
      tools: { list_tasks: tool({ description: 'List', inputSchema: z.object({ limit: z.number() }), execute }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    const output = await prepared.execute('list_tasks', '{"limit":5}');

    expect(execute).toHaveBeenCalledWith({ limit: 5 }, expect.objectContaining({ toolCallId: expect.any(String) }));
    expect(JSON.parse(output)).toEqual({ count: 2, tasks: ['a', 'b'] });
  });

  it('treats empty arguments as an empty object', async () => {
    const execute = vi.fn().mockResolvedValue('done');
    mockCollectTools.mockResolvedValue({
      tools: { ping: tool({ description: 'Ping', inputSchema: z.object({}), execute }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    expect(await prepared.execute('ping', '')).toBe('done');
    expect(execute).toHaveBeenCalledWith({}, expect.anything());
  });

  it('reports a failing tool as text instead of throwing mid-call', async () => {
    mockCollectTools.mockResolvedValue({
      tools: {
        boom: tool({
          description: 'Explodes',
          inputSchema: z.object({}),
          execute: async () => {
            throw new Error('cluster unreachable');
          },
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    const output = await prepared.execute('boom', '{}');

    // The model must be able to say "I couldn't check that" rather than go silent.
    expect(JSON.parse(output)).toEqual({ error: 'cluster unreachable' });
  });

  it('reports an unknown tool rather than throwing', async () => {
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(JSON.parse(await prepared.execute('nope', '{}'))).toEqual({ error: 'Unknown tool: nope' });
  });

  it('reports malformed arguments rather than throwing', async () => {
    mockCollectTools.mockResolvedValue({
      tools: { ping: tool({ description: 'Ping', inputSchema: z.object({}), execute: async () => 'ok' }) },
      subagents: [],
    });
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(JSON.parse(await prepared.execute('ping', '{not json'))).toEqual({
      error: 'Invalid JSON arguments for ping',
    });
  });

  it('truncates a huge result so the model does not read a dump aloud', async () => {
    mockCollectTools.mockResolvedValue({
      tools: {
        dump: tool({
          description: 'Dumps',
          inputSchema: z.object({}),
          // Head and tail differ, so the cut can be shown to keep both ends.
          execute: async () => 'x'.repeat(40_000) + 'TAIL',
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    const output = await prepared.execute('dump', '{}');

    expect(output.length).toBeLessThan(40_000);
    // Chat's shape: head AND tail survive, so a payload's closing lines are still
    // readable. Only the middle goes.
    expect(output.startsWith('x'.repeat(1000))).toBe(true);
    expect(output.endsWith('TAIL')).toBe(true);
    // The notice has to say the result is incomplete, or the model reports what it
    // can see as the whole of it — the bug this replaced.
    expect(output).toContain('INCOMPLETE OUTPUT');
    expect(output).toContain('Do not state a count');
    // …plus the one instruction that belongs to a live call.
    expect(output).toContain('this call is your only channel');
  });

  it('hands over a result that fits the meeting budget whole', async () => {
    // 8,000 chars is a realistic Jira issue with its description, or a listing of a
    // few dozen PRs. The old 4,000-char cap beheaded both.
    mockCollectTools.mockResolvedValue({
      tools: {
        issue: tool({
          description: 'Reads an issue',
          inputSchema: z.object({}),
          execute: async () => 'y'.repeat(8_000),
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    const output = await prepared.execute('issue', '{}');

    expect(output).toBe('y'.repeat(8_000));
  });

  it('does not cut a result that only just passes the budget', async () => {
    // Shared with the chat path: paying ~450 chars of notice to remove 200 costs the
    // model more than it saves, so a small overshoot is delivered whole.
    mockCollectTools.mockResolvedValue({
      tools: {
        listing: tool({
          description: 'Lists',
          inputSchema: z.object({}),
          execute: async () => 'w'.repeat(12_200),
        }),
      },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    expect(await prepared.execute('listing', '{}')).toBe('w'.repeat(12_200));
  });

  it('renders a string result verbatim', async () => {
    mockCollectTools.mockResolvedValue({
      tools: { say: tool({ description: 'Say', inputSchema: z.object({}), execute: async () => 'three pods are down' }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });
    expect(await prepared.execute('say', '{}')).toBe('three pods are down');
  });
});
