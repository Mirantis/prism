import { tool, type Tool } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { createPendingFileWrites } from '../../lib/pending-file-writes';
import { ToolRiskGateError } from '../../lib/tool-risk-gate';
import { withModelOnlyOutput } from './model-only';
import { createProgramTool, PROGRAM_TOOL_NAME, type ProgramCall } from './run-program';
import { MAX_PRINTED_CHARS, runInSandbox, type SandboxLimits } from './sandbox';

vi.mock('../../lib/telemetry', () => ({ trackEvent: vi.fn() }));

const LIMITS: SandboxLimits = { timeoutMs: 5_000, maxToolCalls: 50, maxConcurrentCalls: 3, sliceMs: 500, cpuBudgetMs: 5_000 };

const runOptions = { toolCallId: 'call-1', messages: [] };

function execute(program: Tool, code: string, abortSignal?: AbortSignal): Promise<string> {
  return program.execute!({ code }, { ...runOptions, abortSignal }) as Promise<string>;
}

const items = Array.from({ length: 20 }, (_, i) => ({ id: i, price: i * 10, category: i % 2 ? 'odd' : 'even' }));

function inventoryTools(): Record<string, Tool> {
  return {
    list_items: tool({
      description: 'List item ids.',
      inputSchema: z.object({}),
      execute: async () => items.map((item) => item.id),
    }),
    get_item: tool({
      description: 'Get one item.',
      inputSchema: z.object({ id: z.number() }),
      execute: async ({ id }) => {
        const item = items.find((candidate) => candidate.id === id);
        if (!item) throw new Error(`No item ${id}`);
        return item;
      },
    }),
  };
}

describe('run_program', () => {
  it('calls tools in a loop and returns only what the program prints and returns', async () => {
    const program = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(
      program,
      `const ids = await tools.list_items();
       const all = await Promise.all(ids.map((id) => tools.get_item({ id })));
       const odd = all.filter((item) => item.category === 'odd');
       console.log('odd items:', odd.length);
       return { total: odd.reduce((sum, item) => sum + item.price, 0) };`,
    );
    expect(output).toBe('odd items: 10\n\nReturned: {\n  "total": 1000\n}\n\n(21 tool calls)');
  });

  it('rejects a call whose input does not match the tool schema, and the program can catch it', async () => {
    const program = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(
      program,
      `try { await tools.get_item({ id: 'seven' }); } catch (err) { console.log('caught', err.message.startsWith('Invalid input')); }
       try { await tools.get_item({ id: 99 }); } catch (err) { console.log(err.message); }`,
    );
    expect(output).toContain('caught true');
    expect(output).toContain('No item 99');
  });

  it('reports an uncaught error after what the program printed', async () => {
    const program = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(program, `console.log('before'); await tools.get_item({ id: 99 });`);
    expect(output).toBe('before\n\nProgram stopped (error): Error: No item 99\n\n(1 tool call)');
  });

  it('names the available tools when the program calls one that does not exist', async () => {
    const program = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(program, `await tools.delete_everything();`);
    expect(output).toContain('No tool named delete_everything. Available: list_items, get_item');
  });

  it('keeps itself and image tools off `tools`', async () => {
    const withImage: Record<string, Tool> = {
      ...inventoryTools(),
      screenshot: withModelOnlyOutput({ ...tool({ description: 'x', inputSchema: z.object({}), execute: async () => 'png' }), toModelOutput: () => ({ type: 'text', value: '' }) } as Tool),
    };
    withImage[PROGRAM_TOOL_NAME] = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const program = createProgramTool(withImage, { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(program, `return Object.keys(tools);`);
    expect(output).toContain('"list_items",\n  "get_item"\n]');
  });

  it('calls an MCP tool and gives the program its structured content, or else its text', async () => {
    // `@ai-sdk/mcp` gives every MCP tool a `toModelOutput`.
    const mcp = (result: unknown): Tool =>
      ({
        ...tool({ description: 'MCP.', inputSchema: z.object({}), execute: async () => result }),
        toModelOutput: () => ({ type: 'text', value: '' }),
      }) as Tool;
    const program = createProgramTool(
      {
        list_pods: mcp({ content: [{ type: 'text', text: 'pod-a' }, { type: 'text', text: 'pod-b' }] }),
        get_pod: mcp({ content: [{ type: 'text', text: '{"name":"pod-a"}' }], structuredContent: { name: 'pod-a' } }),
        broken: mcp({ content: [{ type: 'text', text: 'cluster unreachable' }], isError: true }),
      },
      { userId: 'u', agentId: 'a', invocationMode: 'chat' },
    );
    const output = await execute(
      program,
      `console.log(await tools.list_pods()); console.log((await tools.get_pod()).name);
       try { await tools.broken(); } catch (err) { console.log(err.message); }`,
    );
    expect(output).toContain('pod-a\npod-b\npod-a\ncluster unreachable');
  });

  it('reports an MCP error result once, as a failed call', async () => {
    const calls: ProgramCall[] = [];
    const broken = {
      ...tool({
        description: 'MCP.',
        inputSchema: z.object({}),
        execute: async () => ({ content: [{ type: 'text', text: 'cluster unreachable' }], isError: true }),
      }),
      toModelOutput: () => ({ type: 'text', value: '' }),
    } as Tool;
    const program = createProgramTool(
      { broken },
      { userId: 'u', agentId: 'a', invocationMode: 'chat', onCall: (call) => calls.push(call) },
    );
    await execute(program, `try { await tools.broken(); } catch {}`);
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty('output');
    expect(calls[0].error).toEqual(new Error('cluster unreachable'));
  });

  it('says so when the output was cut at the print cap, and keeps the return value', async () => {
    const program = createProgramTool(inventoryTools(), { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const output = await execute(
      program,
      `const line = 'x'.repeat(999);
       for (let i = 0; i < 1001; i++) console.log(line);
       console.log('the answer is 42');
       return 42;`,
    );
    expect(output).not.toContain('the answer is 42');
    expect(output).toContain('(Output cut at 1,000,000 characters');
    expect(output).toContain('Returned: 42');
  });

  it('stops a cancelled turn', async () => {
    const controller = new AbortController();
    const slow = tool({
      description: 'Waits until aborted.',
      inputSchema: z.object({}),
      execute: (_input, { abortSignal }) =>
        new Promise((_resolve, reject) => abortSignal?.addEventListener('abort', () => reject(new Error('aborted')))),
    });
    const program = createProgramTool({ slow }, { userId: 'u', agentId: 'a', invocationMode: 'chat' });
    const running = execute(program, `await tools.slow();`, controller.signal);
    setTimeout(() => controller.abort(), 50);
    expect(await running).toContain('Program stopped (canceled)');
  });

  it('reports each call it made, a refusal by the risk gate included', async () => {
    const calls: ProgramCall[] = [];
    const refused = tool({
      description: 'Refused.',
      inputSchema: z.object({}),
      execute: async () => {
        throw new ToolRiskGateError('TOOL_RISK_BLOCKED', 'high', 'destructive');
      },
    });
    const program = createProgramTool(
      { ...inventoryTools(), refused },
      { userId: 'u', agentId: 'a', invocationMode: 'chat', onCall: (call) => calls.push(call) },
    );
    await execute(program, `await tools.get_item({ id: 3 }); try { await tools.refused(); } catch {}`);
    expect(calls).toEqual([
      { parentCallId: 'call-1', toolCallId: 'call-1:1', toolName: 'get_item', input: { id: 3 }, output: items[3] },
      expect.objectContaining({ parentCallId: 'call-1', toolCallId: 'call-1:2', toolName: 'refused', error: expect.any(ToolRiskGateError) }),
    ]);
  });

  it('holds a reader in its step until the program ends, but not a reader inside the program', async () => {
    const pendingWrites = createPendingFileWrites();
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    const reader = tool({
      description: 'Reads after the pending writes.',
      inputSchema: z.object({}),
      onInputAvailable: ({ toolCallId }) => pendingWrites.announce(toolCallId, 'reader'),
      execute: async (_input, { toolCallId }) =>
        (await pendingWrites.waitFor('/w/file', { timeoutMs: 2_000, callerId: toolCallId })).status,
    });
    const gate = tool({ description: 'Waits.', inputSchema: z.object({}), execute: () => released });
    const program = createProgramTool({ reader, gate }, { userId: 'u', agentId: 'a', invocationMode: 'chat', pendingWrites });

    await program.onInputAvailable!({ ...runOptions, input: { code: '' } });
    const running = execute(program, `console.log(await tools.reader()); await tools.gate();`);
    const sibling = pendingWrites.waitFor('/w/file', { timeoutMs: 2_000, callerId: 'call-2' });
    setTimeout(release, 50);
    expect(await running).toContain('none');
    expect((await sibling).status).toBe('settled');
  });

  it('lets two programs in one step each read after the writes made inside them', async () => {
    const pendingWrites = createPendingFileWrites();
    const reader = tool({
      description: 'Reads after the pending writes.',
      inputSchema: z.object({}),
      onInputAvailable: ({ toolCallId }) => pendingWrites.announce(toolCallId, 'reader'),
      execute: async (_input, { toolCallId }) =>
        (await pendingWrites.waitFor('/w/file', { timeoutMs: 2_000, callerId: toolCallId })).status,
    });
    const options = { userId: 'u', agentId: 'a', invocationMode: 'chat', pendingWrites };
    const first = createProgramTool({ reader }, options);
    const second = createProgramTool({ reader }, options);
    await first.onInputAvailable!({ toolCallId: 'call-1', messages: [], input: { code: '' } });
    await second.onInputAvailable!({ toolCallId: 'call-2', messages: [], input: { code: '' } });

    const started = Date.now();
    const outputs = await Promise.all([
      first.execute!({ code: 'console.log(await tools.reader());' }, { toolCallId: 'call-1', messages: [] }),
      second.execute!({ code: 'console.log(await tools.reader());' }, { toolCallId: 'call-2', messages: [] }),
    ]);
    expect(outputs).toEqual([expect.stringContaining('none'), expect.stringContaining('none')]);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe('runInSandbox', () => {
  const noTools = { toolNames: [], callTool: async () => null, limits: LIMITS };

  it('gives the program no host access', async () => {
    const result = await runInSandbox({
      ...noTools,
      code: `return [typeof process, typeof require, typeof setTimeout, typeof fetch, typeof __call, typeof __print];`,
    });
    expect(result.status).toBe('ok');
    expect(JSON.parse(result.returned!)).toEqual(Array(6).fill('undefined'));
  });

  it('flags printed output cut at the cap, and only then', async () => {
    const short = await runInSandbox({ ...noTools, code: `console.log('hi');` });
    expect(short).toMatchObject({ printed: 'hi\n', printedCut: false });

    const long = await runInSandbox({
      ...noTools,
      code: `for (let i = 0; i < 1001; i++) console.log('x'.repeat(999)); console.log('end');`,
    });
    expect(long.status).toBe('ok');
    expect(long.printedCut).toBe(true);
    expect(long.printed).toHaveLength(MAX_PRINTED_CHARS);
  });

  it('stops a program that computes past the slice limit', async () => {
    const result = await runInSandbox({ ...noTools, code: `while (true) {}` });
    expect(result.status).toBe('timeout');
    expect(result.error).toBe('The program computed too long without waiting on a tool.');
  });

  it('stops a program that waits past the wall limit', async () => {
    const result = await runInSandbox({
      code: `await tools.wait();`,
      toolNames: ['wait'],
      callTool: (_name, _input, signal) =>
        new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))),
      limits: { ...LIMITS, timeoutMs: 100 },
    });
    expect(result.status).toBe('timeout');
  });

  it('stops a program past the tool-call limit', async () => {
    const result = await runInSandbox({
      code: `for (let i = 0; i < 100; i++) await tools.ping();`,
      toolNames: ['ping'],
      callTool: async () => 'pong',
      limits: { ...LIMITS, maxToolCalls: 5 },
    });
    expect(result.status).toBe('call_limit');
    expect(result.toolCalls).toBe(6);
  });

  it('keeps no more calls in flight than the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const result = await runInSandbox({
      code: `await Promise.all(Array.from({ length: 12 }, () => tools.work()));`,
      toolNames: ['work'],
      callTool: async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return null;
      },
      limits: LIMITS,
    });
    expect(result.status).toBe('ok');
    expect(result.toolCalls).toBe(12);
    expect(peak).toBe(LIMITS.maxConcurrentCalls);
  });

  it('runs nothing when the turn was already canceled', async () => {
    const callTool = vi.fn(async () => null);
    const result = await runInSandbox({
      code: `await tools.ping();`,
      toolNames: ['ping'],
      callTool,
      limits: LIMITS,
      abortSignal: AbortSignal.abort(),
    });
    expect(result.status).toBe('canceled');
    expect(callTool).not.toHaveBeenCalled();
  });

  it('reports the slice limit when it ends inside a promise job', async () => {
    for (let i = 0; i < 5; i++) {
      const startedAt = Date.now();
      const result = await runInSandbox({
        code: `await tools.ping(); for (;;) await null;`,
        toolNames: ['ping'],
        callTool: async () => 'pong',
        limits: { ...LIMITS, sliceMs: 100 },
      });
      expect(result).toMatchObject({ status: 'timeout', error: 'The program computed too long without waiting on a tool.' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);
    }
  });

  it('stops at the wall limit a program whose tools answer at once, and lets timers run meanwhile', async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 10);
    const result = await runInSandbox({
      code: `for (;;) await tools.ping();`,
      toolNames: ['ping'],
      callTool: async () => 'pong',
      limits: { ...LIMITS, timeoutMs: 300, maxToolCalls: 1_000_000 },
    });
    clearInterval(interval);
    expect(result.status).toBe('timeout');
    expect(result.error).toBe('The program ran longer than 0 seconds.');
    expect(ticks).toBeGreaterThan(5);
  });

  it('stops a program past its interpreter-time budget', async () => {
    const result = await runInSandbox({
      code: `for (;;) { const end = Date.now() + 60; while (Date.now() < end) {} await tools.ping(); }`,
      toolNames: ['ping'],
      callTool: async () => 'pong',
      limits: { ...LIMITS, sliceMs: 100, cpuBudgetMs: 300 },
    });
    expect(result).toMatchObject({ status: 'timeout', error: 'The program computed too long in total.' });
  });

  it('reports a stack overflow and an out-of-memory error as the program\'s error', async () => {
    for (const code of [
      `const f = (n) => f(n + 1) + 1; return f(0);`,
      `const f = async (n) => (await f(n + 1)) + 1; return await f(0);`,
    ]) {
      expect((await runInSandbox({ ...noTools, code })).status).toBe('error');
    }
    const memory = await runInSandbox({
      ...noTools,
      code: `const a = []; for (;;) a.push('x'.repeat(1e7) + a.length);`,
      limits: { ...LIMITS, sliceMs: 10_000 },
    });
    expect(memory).toMatchObject({ status: 'error', error: 'InternalError: out of memory' });
    expect((await runInSandbox({ ...noTools, code: `return 1;` })).returned).toBe('1');
  }, 20_000);

  it('reports a syntax error', async () => {
    const result = await runInSandbox({ ...noTools, code: `const = 1;` });
    expect(result.status).toBe('error');
    expect(result.error).toMatch(/SyntaxError/);
  });
});
