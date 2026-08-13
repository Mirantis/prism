import { describe, it, expect, vi, beforeEach } from 'vitest';
import { tool, jsonSchema } from 'ai';
import { z } from 'zod';

const mockCollectTools = vi.fn();
vi.mock('../../../lib/tool-collection', () => ({
  collectTools: (...args: unknown[]) => mockCollectTools(...args),
}));

// The bridge imports invoke.ts lazily (a real module cycle), and the delegation tool
// calls it through the injected seam. Mocked so a delegated turn runs no model.
const mockInvoke = vi.fn();
vi.mock('../../../invoke', () => ({
  invoke: (...args: unknown[]) => mockInvoke(...args),
}));

const { prepareMeetingTools } = await import('../tool-bridge');
const { DELEGATION_TOOL_NAME } = await import('../delegation-tool');
const { createTranscriptLog } = await import('../call-transcript');

/** The signal a live call supplies: nothing has aborted it. */
const live = () => new AbortController().signal;

beforeEach(() => {
  mockCollectTools.mockReset();
  mockInvoke.mockReset();
});

describe('prepareMeetingTools', () => {
  it('collects tools in meeting mode with no workspace', async () => {
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });

    await prepareMeetingTools({ userId: 'u1', agentId: 'a1', threadId: 't1', lockedIn: false });

    expect(mockCollectTools).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', agentId: 'a1', threadId: 't1', mode: 'meeting', workspaceRoot: undefined }),
    );
  });

  // Declarations are sent once per session, so a call that did not pass the flag
  // would offer a locked agent the six workspace writers for the whole meeting
  // and leave the refusal in the tools as the only guard.
  it('passes the lock through, so the writers are withheld from the declarations', async () => {
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });

    await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: true });

    expect(mockCollectTools).toHaveBeenCalledWith(expect.objectContaining({ lockedIn: true }));
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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

    expect(prepared.declarations.map((d) => d.name)).toEqual(['real']);
  });

  it('executes a tool and returns its result as text', async () => {
    const execute = vi.fn().mockResolvedValue({ count: 2, tasks: ['a', 'b'] });
    mockCollectTools.mockResolvedValue({
      tools: { list_tasks: tool({ description: 'List', inputSchema: z.object({ limit: z.number() }), execute }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    const output = await prepared.execute('list_tasks', '{"limit":5}', live());

    expect(execute).toHaveBeenCalledWith({ limit: 5 }, expect.objectContaining({ toolCallId: expect.any(String) }));
    expect(JSON.parse(output)).toEqual({ count: 2, tasks: ['a', 'b'] });
  });

  it('treats empty arguments as an empty object', async () => {
    const execute = vi.fn().mockResolvedValue('done');
    mockCollectTools.mockResolvedValue({
      tools: { ping: tool({ description: 'Ping', inputSchema: z.object({}), execute }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    expect(await prepared.execute('ping', '', live())).toBe('done');
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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    const output = await prepared.execute('boom', '{}', live());

    // The model must be able to say "I couldn't check that" rather than go silent.
    expect(JSON.parse(output)).toEqual({ error: 'cluster unreachable' });
  });

  it('reports an unknown tool rather than throwing', async () => {
    mockCollectTools.mockResolvedValue({ tools: {}, subagents: [] });
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

    expect(JSON.parse(await prepared.execute('nope', '{}', live()))).toEqual({ error: 'Unknown tool: nope' });
  });

  it('reports malformed arguments rather than throwing', async () => {
    mockCollectTools.mockResolvedValue({
      tools: { ping: tool({ description: 'Ping', inputSchema: z.object({}), execute: async () => 'ok' }) },
      subagents: [],
    });
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

    expect(JSON.parse(await prepared.execute('ping', '{not json', live()))).toEqual({
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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    const output = await prepared.execute('dump', '{}', live());

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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    const output = await prepared.execute('issue', '{}', live());

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

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });

    expect(await prepared.execute('listing', '{}', live())).toBe('w'.repeat(12_200));
  });

  it('renders a string result verbatim', async () => {
    mockCollectTools.mockResolvedValue({
      tools: { say: tool({ description: 'Say', inputSchema: z.object({}), execute: async () => 'three pods are down' }) },
      subagents: [],
    });

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    expect(await prepared.execute('say', '{}', live())).toBe('three pods are down');
  });

  it('hands the call-scoped signal to the tool, so leaving cancels its work', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    mockCollectTools.mockResolvedValue({
      tools: { slow: tool({ description: 'Slow', inputSchema: z.object({}), execute }) },
      subagents: [],
    });

    const controller = new AbortController();
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    await prepared.execute('slow', '{}', controller.signal);

    const passed = execute.mock.calls[0][1].abortSignal as AbortSignal;
    expect(passed.aborted).toBe(false);
    controller.abort();
    // The same signal, not a copy — this is what makes teardown reach a running tool.
    expect(passed.aborted).toBe(true);
  });

  it('does not start a tool for a call that has already ended', async () => {
    const execute = vi.fn().mockResolvedValue('ok');
    mockCollectTools.mockResolvedValue({
      tools: { check: tool({ description: 'Check', inputSchema: z.object({}), execute }) },
      subagents: [],
    });

    const controller = new AbortController();
    controller.abort();
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', lockedIn: false });
    const output = await prepared.execute('check', '{}', controller.signal);

    expect(execute).not.toHaveBeenCalled();
    expect(JSON.parse(output)).toEqual({ error: 'The meeting ended before this could run' });
  });
});

/**
 * `delegate` mode changes what the *Realtime* model is shown, not what the agent can
 * do: the catalog still gets collected, because the delegated turn needs it.
 */
describe('prepareMeetingTools in delegate mode', () => {
  const catalog = () => ({
    tools: {
      memory_search: tool({ description: 'Search', inputSchema: z.object({}), execute: async () => 'y' }),
      shell_exec: tool({ description: 'Shell', inputSchema: z.object({}), execute: async () => 'y' }),
      join_meeting: tool({ description: 'Join', inputSchema: z.object({}), execute: async () => 'y' }),
      leave_meeting: tool({ description: 'Leave', inputSchema: z.object({}), execute: async () => 'left' }),
      meeting_status: tool({ description: 'Status', inputSchema: z.object({}), execute: async () => 'fine' }),
    },
    subagents: [],
  });

  it('offers one delegation tool plus the call\'s own controls', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    // Three, not one: `leave_meeting` and `meeting_status` cannot be delegated —
    // a delegated turn runs in `subagent` mode, which drops the meeting tools
    // precisely so it cannot end the call that spawned it.
    expect(prepared.declarations.map((d) => d.name).sort()).toEqual([
      'handle_request',
      'leave_meeting',
      'meeting_status',
    ]);
    expect(prepared.count).toBe(3);
  });

  it('does not offer join_meeting: the agent is already in a call', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    expect(prepared.declarations.map((d) => d.name)).not.toContain('join_meeting');
  });

  it('refuses a tool it is no longer offering, rather than running it anyway', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    // The declarations and what `execute` will run have to be the same set, or a
    // model working from a stale session config could still reach the whole catalog.
    expect(JSON.parse(await prepared.execute('shell_exec', '{}', live()))).toEqual({
      error: 'Unknown tool: shell_exec',
    });
  });

  it('still runs the call controls it does offer', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    expect(await prepared.execute('leave_meeting', '{}', live())).toBe('left');
  });

  it('still collects the whole catalog, which the delegated turn needs', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    // Same collection as `full` mode. Narrowing here would leave the delegate with
    // nothing to work with — the experiment is about who chooses, not about access.
    expect(mockCollectTools).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'meeting', agentId: 'a1' }),
    );
  });

  it('hands the call\'s transcript to the delegation tool', async () => {
    mockCollectTools.mockResolvedValue(catalog());
    const transcript = createTranscriptLog();
    transcript.append('the staging deploy looks stuck');

    const prepared = await prepareMeetingTools({
      userId: 'u1',
      agentId: 'a1',
      toolMode: 'delegate',
      transcript,
    });
    mockInvoke.mockResolvedValue({ response: 'Looking now.', toolCalls: [], steps: [] });
    await prepared.execute(DELEGATION_TOOL_NAME, '{"request":"check the deploy"}', live());

    // The bridge is the only thing holding both the log and the tool, so a handoff
    // arriving without the transcript is a wiring failure with no other symptom than
    // a delegate that answers as if it had heard nothing.
    const request = mockInvoke.mock.calls[0][0] as {
      cachedPrefix?: { text: string; open?: string };
    };
    expect(`${request.cachedPrefix?.text}${request.cachedPrefix?.open}`).toContain(
      'the staging deploy looks stuck',
    );
  });

  it('counts how the delegated turns went', async () => {
    mockCollectTools.mockResolvedValue(catalog());
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    expect(prepared.delegationStats()).toEqual({
      total: 0,
      failures: 0,
      timeouts: 0,
      truncated: 0,
      msTotal: 0,
    });

    mockInvoke.mockResolvedValue({ response: 'Three pods are restarting.', toolCalls: [], steps: [] });
    await prepared.execute(DELEGATION_TOOL_NAME, '{"request":"check staging"}', live());
    mockInvoke.mockResolvedValue({ response: '', toolCalls: [], steps: [] });
    await prepared.execute(DELEGATION_TOOL_NAME, '{"request":"check prod"}', live());

    const stats = prepared.delegationStats();
    // An empty answer counts as a failure: to the room it is the same event as an
    // errored turn — the agent said it could not do the thing.
    expect(stats).toMatchObject({ total: 2, failures: 1, timeouts: 0, truncated: 0 });
    expect(stats!.msTotal).toBeGreaterThanOrEqual(0);
  });

  it('hands out a copy of the tally, not the tally itself', async () => {
    mockCollectTools.mockResolvedValue(catalog());
    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1', toolMode: 'delegate' });

    const before = prepared.delegationStats()!;
    mockInvoke.mockResolvedValue({ response: 'done', toolCalls: [], steps: [] });
    await prepared.execute(DELEGATION_TOOL_NAME, '{"request":"check staging"}', live());

    // Read at teardown, while a delegation may still be resolving — a live reference
    // would change under the caller between reading it and emitting it.
    expect(before.total).toBe(0);
    expect(prepared.delegationStats()!.total).toBe(1);
  });

  it('has no tally at all in the default mode', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    // Null rather than zeroes: "the experiment was off" must not read as "it was on
    // and delegated nothing".
    expect(prepared.delegationStats()).toBeNull();
  });

  it('offers the whole catalog when the mode is not set', async () => {
    mockCollectTools.mockResolvedValue(catalog());

    const prepared = await prepareMeetingTools({ userId: 'u1', agentId: 'a1' });

    // The default has to be today's behaviour, unchanged.
    expect(prepared.declarations.map((d) => d.name)).not.toContain('handle_request');
    expect(prepared.count).toBe(5);
  });
});
